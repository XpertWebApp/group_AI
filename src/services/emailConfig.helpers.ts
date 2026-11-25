/**
 * Email configuration helpers — shared by:
 *  - settings.service.ts (GET /settings/email, /test-status, /test-send)
 *  - notification.service.ts (live sender identity resolution)
 *
 * Contract from `email-config-settings-handover.md` §4. Keep DB-first + env
 * fallback semantics aligned with `/settings/policies` (admin edit wins).
 */
import nodemailer, { Transporter } from 'nodemailer';
import settingsRepository from '../repositories/settings.repository';
import { SettingCategory } from '@prisma/client';
import logger from '../utils/logger';

// ─── Sender-identity resolution (DB-first, env fallback) ────────────────────

/**
 * The four admin-editable keys we store under settings.email. Kept in this
 * one place so the Zod schema, the service, the controller, and the cache
 * never drift.
 */
export const EMAIL_SENDER_KEYS = [
    'fromName',
    'fromEmail',
    'replyToFallback',
    'staffNotificationEmail',
] as const;

export type EmailSenderKey = (typeof EMAIL_SENDER_KEYS)[number];

export interface SenderIdentity {
    fromName: string;
    fromEmail: string;
    replyToFallback: string;
    staffNotificationEmail: string;
}

/** Env-side defaults, used when the DB row is empty/unset. */
function envDefault(key: EmailSenderKey): string {
    switch (key) {
        case 'fromName':
            return process.env.SMTP_FROM_NAME ?? '';
        case 'fromEmail':
            return process.env.SMTP_FROM_EMAIL ?? '';
        case 'replyToFallback':
            return (
                process.env.SMTP_REPLY_TO ??
                process.env.SMTP_REPLY_TO_FALLBACK ??
                process.env.SMTP_FROM_EMAIL ??
                ''
            );
        case 'staffNotificationEmail':
            return process.env.STAFF_NOTIFICATION_EMAIL ?? '';
    }
}

/**
 * Lightweight in-process cache so hot send paths don't hit the DB on every
 * `resolveFrom()` call. TTL is short because admin edits should take effect
 * immediately on the next send — 30 seconds is the worst-case staleness, and
 * `bustSenderCache()` clears it the moment the PUT endpoint writes.
 */
const SENDER_CACHE_TTL_MS = 30_000;
let senderCache: { values: Record<EmailSenderKey, string>; loadedAt: number } | null = null;

async function loadSenderRecord(): Promise<Record<EmailSenderKey, string>> {
    const row = await settingsRepository.getByCategory(SettingCategory.email);
    const out: Record<string, string> = {};
    for (const key of EMAIL_SENDER_KEYS) {
        const dbVal = (row as Record<string, string | null | undefined>)[key];
        out[key] = dbVal && String(dbVal).trim() !== '' ? String(dbVal) : envDefault(key);
    }
    return out as Record<EmailSenderKey, string>;
}

export async function getSenderIdentity(): Promise<SenderIdentity> {
    const now = Date.now();
    if (senderCache && now - senderCache.loadedAt < SENDER_CACHE_TTL_MS) {
        return { ...senderCache.values };
    }
    const values = await loadSenderRecord();
    senderCache = { values, loadedAt: now };
    return { ...values };
}

export function bustSenderCache(): void {
    senderCache = null;
}

/**
 * Sync accessor — used by the notification send path where we don't want to
 * push every caller into async. Reads from the cache; if cold, returns env
 * defaults. The next `getSenderIdentity()` from settings or any cold path
 * will warm the cache.
 */
export function getSenderIdentitySync(): SenderIdentity {
    if (senderCache) return { ...senderCache.values };
    return {
        fromName: envDefault('fromName'),
        fromEmail: envDefault('fromEmail'),
        replyToFallback: envDefault('replyToFallback'),
        staffNotificationEmail: envDefault('staffNotificationEmail'),
    };
}

/**
 * Warm the cache early at boot so the first send doesn't pay a DB hit.
 * Safe to call before/after the Express listener is up.
 */
export async function warmSenderCache(): Promise<void> {
    try {
        await getSenderIdentity();
    } catch (err) {
        logger.warn({ err }, 'Failed to warm email-sender cache — will retry on first send');
    }
}

// ─── Brevo connection chrome (read-only on the wire) ────────────────────────

export interface BrevoConnectionChrome {
    provider: string;
    host: string | null;
    port: number | null;
    security: 'STARTTLS' | 'SSL' | 'TLS' | null;
    usernameMasked: string | null;
    passwordMasked: string | null;
    /** True when SMTP_HOST is set — the BE can construct a real transport. */
    configured: boolean;
}

/**
 * Mask a username so the page can show "8a****@smtp-brevo.com" without
 * leaking the raw value. Strategy:
 *  - keep the first 2 chars + the domain part (everything from "@" onward)
 *  - replace the rest of the local part with "****"
 * Falls back to "****" for short or domain-less usernames.
 */
export function maskUsername(value: string | null | undefined): string | null {
    if (!value) return null;
    const s = String(value);
    const atIdx = s.indexOf('@');
    if (atIdx < 0) {
        // No "@" — Brevo's actual SMTP usernames look like "8a1234@smtp-brevo.com",
        // so this branch is rare; mask everything but the first 2 chars.
        if (s.length <= 2) return '****';
        return `${s.slice(0, 2)}****`;
    }
    const local = s.slice(0, atIdx);
    const domain = s.slice(atIdx);
    if (local.length <= 2) return `****${domain}`;
    return `${local.slice(0, 2)}****${domain}`;
}

/** Fixed-length password mask — never echo length. */
export function maskPassword(value: string | null | undefined): string | null {
    if (!value) return null;
    return '••••••••••••';
}

function resolveSmtpSecurity(): 'STARTTLS' | 'SSL' | 'TLS' | null {
    const explicit = (process.env.SMTP_SECURITY ?? '').toUpperCase();
    if (explicit === 'STARTTLS' || explicit === 'SSL' || explicit === 'TLS') return explicit;
    if (process.env.SMTP_SECURE === 'true') return 'SSL';
    if (process.env.SMTP_HOST) return 'STARTTLS';
    return null;
}

export function getBrevoConnectionChrome(): BrevoConnectionChrome {
    const host = process.env.SMTP_HOST ?? null;
    const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : (host ? 587 : null);
    const user = process.env.SMTP_USERNAME ?? process.env.SMTP_USER ?? null;
    const pass = process.env.SMTP_PASSWORD ?? process.env.SMTP_PASS ?? null;
    return {
        provider: 'Brevo (SMTP relay)',
        host,
        port,
        security: resolveSmtpSecurity(),
        usernameMasked: maskUsername(user),
        passwordMasked: maskPassword(pass),
        configured: !!host,
    };
}

// ─── Transport + verify (60s status cache) ───────────────────────────────────

/**
 * Build a fresh transporter. Identical to the one notification.service.ts uses
 * internally — kept here so verify()/test-send don't depend on the
 * notification module (avoiding a circular import).
 */
export function createBrevoTransport(): Transporter | null {
    const host = process.env.SMTP_HOST;
    if (!host) return null;
    const user = process.env.SMTP_USERNAME ?? process.env.SMTP_USER;
    const pass = process.env.SMTP_PASSWORD ?? process.env.SMTP_PASS;
    const security = resolveSmtpSecurity();
    return nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: security === 'SSL' || security === 'TLS',
        auth: user ? { user, pass } : undefined,
    });
}

export interface TestStatusResult {
    configured: boolean;
    status: 'connected' | 'error' | 'untested';
    statusError: string | null;
    lastTestedAt: string | null;
}

const STATUS_CACHE_TTL_MS = 60_000;
let statusCache: { result: TestStatusResult; cachedAt: number } | null = null;

export async function getEmailTestStatus(opts?: { forceFresh?: boolean }): Promise<TestStatusResult> {
    const force = opts?.forceFresh === true;
    if (!force && statusCache && Date.now() - statusCache.cachedAt < STATUS_CACHE_TTL_MS) {
        return { ...statusCache.result };
    }

    const transport = createBrevoTransport();
    if (!transport) {
        const result: TestStatusResult = {
            configured: false,
            status: 'untested',
            statusError: null,
            lastTestedAt: null,
        };
        statusCache = { result, cachedAt: Date.now() };
        return { ...result };
    }

    const now = new Date().toISOString();
    try {
        await transport.verify();
        const result: TestStatusResult = {
            configured: true,
            status: 'connected',
            statusError: null,
            lastTestedAt: now,
        };
        statusCache = { result, cachedAt: Date.now() };
        return { ...result };
    } catch (err: any) {
        const errMsg = String(err?.message ?? err ?? 'Unknown SMTP error').slice(0, 240);
        const result: TestStatusResult = {
            configured: true,
            status: 'error',
            statusError: errMsg,
            lastTestedAt: now,
        };
        statusCache = { result, cachedAt: Date.now() };
        return { ...result };
    }
}

export function bustStatusCache(): void {
    statusCache = null;
}

// ─── Intercept transparency ──────────────────────────────────────────────────

export function getInterceptStatus(): { active: boolean; target: string | null } {
    const target = (process.env.EMAIL_INTERCEPT_TO ?? '').trim();
    return target ? { active: true, target } : { active: false, target: null };
}

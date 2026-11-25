import { SettingCategory } from '@prisma/client';
import settingsRepository from '../repositories/settings.repository';
import supplierLimitsRepository from '../repositories/supplierLimits.repository';
import staffRepository from '../repositories/staff.repository';
import { refreshSupplierLimitsCache, type SupplierPriority } from '../config/supplierLimits';
import { sanitisePolicyHtml, isFullyStrippedByPolicy } from '../utils/sanitisePolicyHtml';
import {
    EMAIL_SENDER_KEYS,
    EmailSenderKey,
    SenderIdentity,
    getSenderIdentity,
    bustSenderCache,
    getBrevoConnectionChrome,
    getEmailTestStatus,
    getInterceptStatus,
    createBrevoTransport,
    TestStatusResult,
} from './emailConfig.helpers';
import logger from '../utils/logger';

// ─── Default markup cache ────────────────────────────────────────────────────
// The price engine reads the default markup percentage on every hotel-search
// orchestration and every proposal recompute. Caching the parsed number for
// 30s keeps the hot path off the DB without making admin edits feel stale
// (PUT /settings/general busts this immediately via bustMarkupCache()).

const MARKUP_CACHE_TTL_MS = 30_000;
const LEGACY_FALLBACK_PERCENT = 18;
let markupCache: { value: number; loadedAt: number } | null = null;

/**
 * DB-first markup resolver. Reads `settings.general.defaultMarkupPercentage`,
 * parses it as a float, returns the parsed value. Falls back to the legacy
 * 18 % when the row is missing or unparseable — never throws, never returns
 * NaN, so the offer pipeline can't crash on a misconfigured Settings row.
 */
async function resolveDefaultMarkupPercent(): Promise<number> {
    const now = Date.now();
    if (markupCache && now - markupCache.loadedAt < MARKUP_CACHE_TTL_MS) {
        return markupCache.value;
    }
    try {
        const row = await settingsRepository.getByCategory(SettingCategory.general);
        const raw = (row as Record<string, string | null | undefined>)?.defaultMarkupPercentage;
        const n = raw != null ? parseFloat(String(raw)) : NaN;
        const value = Number.isFinite(n) && n >= 0 ? n : LEGACY_FALLBACK_PERCENT;
        markupCache = { value, loadedAt: now };
        return value;
    } catch (err) {
        logger.warn({ err }, 'Failed to read defaultMarkupPercentage from settings — using legacy 18%');
        return LEGACY_FALLBACK_PERCENT;
    }
}

/** Clear the cache so the next read picks up the freshly-written DB value. */
function bustMarkupCache(): void {
    markupCache = null;
}

/**
 * Public sync accessor — used by the hotel-search hot path where every
 * inner-loop `await` adds measurable latency. Returns the cached value or
 * the legacy fallback (18 %) when the cache is cold. The price engine
 * should `await getDefaultMarkupPercent()` once at the top of each search
 * orchestration to warm the cache; subsequent reads inside that orchestration
 * can use this sync accessor.
 */
export function getDefaultMarkupPercentSync(): number {
    return markupCache?.value ?? LEGACY_FALLBACK_PERCENT;
}

/**
 * Public async accessor — call this once at the top of any orchestrator that
 * needs the markup, then use `getDefaultMarkupPercentSync()` for downstream
 * reads. Returns the resolved value AND warms the cache.
 */
export async function loadDefaultMarkupPercent(): Promise<number> {
    return resolveDefaultMarkupPercent();
}

export class SettingsService {
    /**
     * Returns the settings overview for the main settings page (5 cards with last-updated timestamps).
     */
    async getOverview() {
        const [categoryTimestamps, supplierLimitsUpdated, staffCount] = await Promise.all([
            settingsRepository.getLastUpdatedByCategory(),
            supplierLimitsRepository.getLastUpdated(),
            staffRepository.countAll(),
        ]);

        return {
            general: { updatedAt: categoryTimestamps.general },
            supplierLimits: { updatedAt: supplierLimitsUpdated },
            email: { updatedAt: categoryTimestamps.email },
            company: { updatedAt: categoryTimestamps.company },
            policies: { updatedAt: categoryTimestamps.policies },
            staff: { totalStaff: staffCount },
        };
    }

    // ── General Configuration ────────────────────────────────────────────────

    async getGeneralConfig() {
        return settingsRepository.getByCategory(SettingCategory.general);
    }

    async updateGeneralConfig(data: { defaultMarkupPercentage: string }) {
        await settingsRepository.upsertMany(SettingCategory.general, {
            defaultMarkupPercentage: data.defaultMarkupPercentage,
        });
        // Bust + re-warm so the next sync read (calculateSellPrice,
        // recalcTotals) returns the new value immediately, without waiting
        // for some other code path to call the async loader.
        bustMarkupCache();
        await resolveDefaultMarkupPercent();
        return this.getGeneralConfig();
    }

    /**
     * Resolve the default markup percentage that the price engine should apply
     * when no per-hotel / per-supplier override exists. DB-first (admin
     * Settings page); falls back to the legacy 18 % when settings is empty or
     * unparseable so the offer pipeline can never crash on a missing row.
     *
     * Precedence (per FE handover):
     *   1. supplier-specific override   (NOT IMPLEMENTED — SupplierLimit has no
     *                                    markup column yet; add when product ships
     *                                    per-supplier markups)
     *   2. settings.general.defaultMarkupPercentage  ← this method
     *   3. legacy hard-coded 18 %       (only used as crash-proof fallback)
     */
    async getDefaultMarkupPercent(): Promise<number> {
        return resolveDefaultMarkupPercent();
    }

    // ── Email Configuration (Brevo SMTP) ────────────────────────────────────
    // Contract per `email-config-settings-handover.md` §4. Three blocks:
    //  - senderIdentity: admin-editable (fromName, fromEmail, replyToFallback,
    //                    staffNotificationEmail)
    //  - connection:     read-only Brevo SMTP chrome (host, port, masked
    //                    creds, configured flag, live status)
    //  - intercept:      EMAIL_INTERCEPT_TO transparency (QA safety net)
    //
    // Sender-identity values live in the `settings.email` category in the DB,
    // with env fallback at resolve-time. See emailConfig.helpers.ts.

    /**
     * Returns the full email-config payload shaped for the redesigned
     * Settings → Email Configuration page (3-card layout).
     */
    async getEmailConfig() {
        const [senderIdentity, connection, status] = await Promise.all([
            getSenderIdentity(),
            Promise.resolve(getBrevoConnectionChrome()),
            // Use the cached status — do NOT block this endpoint on a live
            // verify call (handover §6.5). The FE can hit /test-status to
            // refresh the dot on demand.
            getEmailTestStatus().catch(() => ({
                configured: false,
                status: 'untested' as const,
                statusError: null,
                lastTestedAt: null,
            } as TestStatusResult)),
        ]);

        return {
            senderIdentity,
            connection: {
                ...connection,
                status: status.status,
                statusError: status.statusError,
                lastTestedAt: status.lastTestedAt,
            },
            intercept: getInterceptStatus(),
        };
    }

    /**
     * Partial update of senderIdentity. Empty-string values clear the DB
     * row so the next resolve picks up the env default
     * (`email-config-settings-handover.md` §4.2: "Empty string '' is accepted
     * for any field and means 'clear this; fall back to env at send time'").
     *
     * Unknown keys are ignored — Zod has already validated the body.
     */
    async updateEmailConfig(data: {
        fromName?: string;
        fromEmail?: string;
        replyToFallback?: string;
        staffNotificationEmail?: string;
    }) {
        const updates: Record<string, string> = {};
        for (const key of EMAIL_SENDER_KEYS) {
            const value = (data as Record<EmailSenderKey, string | undefined>)[key];
            if (value !== undefined) updates[key] = String(value);
        }

        if (Object.keys(updates).length > 0) {
            await settingsRepository.upsertMany(SettingCategory.email, updates);
            bustSenderCache();
            logger.info({ keys: Object.keys(updates) }, 'Email sender identity updated');
        }

        // Return the same shape as GET so the FE can re-render off the PUT
        // response without an extra round-trip.
        return this.getEmailConfig();
    }

    /**
     * Force-refreshes the SMTP transport status. Called by
     * `GET /settings/email/test-status` when the FE wants a fresh ping.
     */
    async refreshEmailTestStatus() {
        // forceFresh=true bypasses the 60s cache, hits Brevo, repopulates.
        return getEmailTestStatus({ forceFresh: true });
    }

    /**
     * Sends a small test email via the live Brevo transport. The body is
     * fixed by the BE so the FE doesn't have to compose it.
     */
    async sendTestEmail(to: string): Promise<{ delivered: true; messageId: string; sentAt: string }> {
        const transport = createBrevoTransport();
        if (!transport) {
            const err: any = new Error('Email is not configured (no SMTP_HOST in env).');
            err.status = 503;
            err.code = 'NOT_CONFIGURED';
            throw err;
        }

        const sender = await getSenderIdentity();
        const fromHeader = sender.fromName && sender.fromEmail
            ? `${sender.fromName} <${sender.fromEmail}>`
            : sender.fromEmail || 'groups@s-e-t-t.com';

        const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:32px;background:#f5f5f5;font-family:Montserrat,Arial,sans-serif;color:#071C42">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;border-top:6px solid #AAC737">
    <h1 style="margin:0 0 16px 0;font-size:20px;color:#071C42">SETT Hub email configuration test</h1>
    <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#686868">
      If you can read this, the SETT Hub email pipeline is working correctly.
    </p>
    <p style="margin:0 0 0 0;font-size:13px;line-height:1.6;color:#686868">
      Sent at <strong style="color:#071C42">${new Date().toISOString()}</strong>
      via <strong style="color:#071C42">Brevo (SMTP relay)</strong>.
    </p>
  </div>
</body>
</html>`;

        try {
            const info = await transport.sendMail({
                from: fromHeader,
                to,
                subject: 'SETT Hub email configuration test',
                html,
                replyTo: sender.replyToFallback || sender.fromEmail || 'groups@s-e-t-t.com',
                headers: { 'X-Sett-Purpose': 'config-test' },
            });
            return {
                delivered: true,
                messageId: info.messageId ?? '',
                sentAt: new Date().toISOString(),
            };
        } catch (err: any) {
            const message = String(err?.message ?? err ?? 'Unknown SMTP error');
            const wrapped: any = new Error(message);
            wrapped.status = 502;
            wrapped.code = 'SMTP_ERROR';
            throw wrapped;
        }
    }

    // ── Company Details ──────────────────────────────────────────────────────

    async getCompanyDetails() {
        return settingsRepository.getByCategory(SettingCategory.company);
    }

    async updateCompanyDetails(data: {
        companyName: string;
        assignedPerson: string;
        emailAddress: string;
        phoneNumber: string;
        phoneCountryCode?: string | null;
        website: string;
        taxId: string;
        address: string;
    }) {
        // Filter out undefined values — settingsRepository expects Record<string, string>
        const cleaned: Record<string, string> = {};
        for (const [key, value] of Object.entries(data)) {
            if (value !== undefined && value !== null) {
                cleaned[key] = String(value);
            }
        }
        await settingsRepository.upsertMany(SettingCategory.company, cleaned);
        return this.getCompanyDetails();
    }

    // ── Policies ─────────────────────────────────────────────────────────────

    async getPolicies() {
        return settingsRepository.getByCategory(SettingCategory.policies);
    }

    async updatePolicies(data: {
        termsConditionsEn?: string;
        termsConditionsDe?: string;
        cancellationConditionsEn?: string;
        cancellationConditionsDe?: string;
    }) {
        // Save-side sanitisation per `policies-rich-text-handover.md` §3.1:
        //  1. Sanitise the incoming HTML fragment against the FE whitelist.
        //  2. Reject with 400 INVALID_HTML when the admin posted content
        //     that's 100 % disallowed markup (e.g. only `<script>` tags).
        //     Empty-string saves are legitimate (admin clearing a field) and
        //     are passed through as empty.
        //  3. Store the sanitised HTML as-is — do NOT re-encode entities or
        //     wrap in extra tags.
        const fields: Array<keyof typeof data> = [
            'termsConditionsEn',
            'termsConditionsDe',
            'cancellationConditionsEn',
            'cancellationConditionsDe',
        ];

        for (const field of fields) {
            const value = data[field];
            if (value === undefined) continue;
            if (isFullyStrippedByPolicy(value)) {
                const err: any = new Error(
                    `${field} contains only disallowed markup — sanitisation stripped everything.`,
                );
                err.status = 400;
                err.code = 'INVALID_HTML';
                throw err;
            }
        }

        const updates: Record<string, string> = {};
        if (data.termsConditionsEn !== undefined) updates.termsConditionsEn = sanitisePolicyHtml(data.termsConditionsEn);
        if (data.termsConditionsDe !== undefined) updates.termsConditionsDe = sanitisePolicyHtml(data.termsConditionsDe);
        if (data.cancellationConditionsEn !== undefined) updates.cancellationConditionsEn = sanitisePolicyHtml(data.cancellationConditionsEn);
        if (data.cancellationConditionsDe !== undefined) updates.cancellationConditionsDe = sanitisePolicyHtml(data.cancellationConditionsDe);

        if (Object.keys(updates).length > 0) {
            await settingsRepository.upsertMany(SettingCategory.policies, updates);
        }
        return this.getPolicies();
    }

    // ── Supplier Limits ──────────────────────────────────────────────────────

    async getSupplierLimits(opts: { search?: string; page?: number; limit?: number }) {
        return supplierLimitsRepository.findAll(opts);
    }

    async createSupplierLimit(data: {
        supplierCode: string;
        providerName: string;
        accCode?: string | null;
        maxRooms?: number;
        groupsAllowed?: boolean;
        priority?: SupplierPriority;
        notes?: string | null;
    }) {
        // supplier_code is not unique — duplicates are allowed by design.
        const result = await supplierLimitsRepository.create(data);
        // Refresh the in-memory cache so hotelSearch picks up the new supplier.
        await refreshSupplierLimitsCache();
        return result;
    }

    /**
     * Update a supplier limit. `idOrCode` is the row's UUID (preferred) or, for
     * backward compatibility, its supplier code.
     */
    async updateSupplierLimit(
        idOrCode: string,
        data: {
            supplierCode?: string;
            providerName?: string;
            accCode?: string | null;
            maxRooms?: number;
            groupsAllowed?: boolean;
            priority?: SupplierPriority;
            notes?: string | null;
        },
    ) {
        const existing = await supplierLimitsRepository.findByIdOrCode(idOrCode);
        if (!existing) {
            throw new Error(`Supplier limit not found: ${idOrCode}`);
        }
        const result = await supplierLimitsRepository.update(existing.id, data);
        // Refresh the in-memory cache so hotelSearch picks up changes immediately.
        await refreshSupplierLimitsCache();
        return result;
    }

    /** Delete a supplier limit by row UUID (or, for compat, supplier code). */
    async deleteSupplierLimit(idOrCode: string) {
        const existing = await supplierLimitsRepository.findByIdOrCode(idOrCode);
        if (!existing) {
            throw new Error(`Supplier limit not found: ${idOrCode}`);
        }
        await supplierLimitsRepository.delete(existing.id);
        await refreshSupplierLimitsCache();
        return { id: existing.id };
    }
}

export default new SettingsService();

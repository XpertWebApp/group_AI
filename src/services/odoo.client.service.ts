/**
 * Odoo CRM client — JSON-RPC integration for live company lookup.
 *
 * Powers the Group Tool's company autocomplete (Oliver's directive: staff
 * must pick a real Odoo customer before an offer can be sent — see
 * memory/project_odoo_client_search.md for the confirmed flow). The only
 * endpoint we talk to is `POST {ODOO_URL}/jsonrpc`.
 *
 * Design choices mirror the WBE client (axios + Bottleneck) so the codebase
 * keeps a single integration pattern.
 *
 * - Auth: `common.authenticate` returns a numeric UID. Cached in memory for
 *   24 h. On any 401 we invalidate and re-auth once before failing.
 * - Rate limit: 5 QPS — Odoo's hosted plans throttle aggressively, and the
 *   FE only fires this from a debounced autocomplete, so a tight reservoir
 *   is plenty.
 * - Logging: Pino. API key NEVER goes into log objects.
 */

import axios from 'axios';
import Bottleneck from 'bottleneck';
import config from '../config';
import logger from '../utils/logger';

const limiter = new Bottleneck({
    reservoir: 5,
    reservoirRefreshAmount: 5,
    reservoirRefreshInterval: 1000,
    maxConcurrent: 3,
    minTime: 200,
});

limiter.on('failed', async (error: any, jobInfo) => {
    if (error?.response?.status === 429 && jobInfo.retryCount < 2) {
        logger.warn({ msg: 'Odoo 429 — retrying', retryCount: jobInfo.retryCount });
        return 1000;
    }
});

export interface OdooCompany {
    id: number;
    name: string;
    email: string | false;
    phone: string | false;
}

/**
 * Thrown when Odoo is reachable but returns a logical error (bad query,
 * stale UID, etc.). The controller maps this to 422.
 */
export class OdooApiError extends Error {
    constructor(message: string, public readonly code?: string) {
        super(message);
        this.name = 'OdooApiError';
    }
}

/**
 * Thrown when we cannot reach Odoo at all (timeout, DNS, 5xx).
 * The controller maps this to 503.
 */
export class OdooUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OdooUnavailableError';
    }
}

const UID_TTL_MS = 24 * 60 * 60 * 1000;

class OdooClientService {
    private cachedUid: { uid: number; fetchedAt: number } | null = null;

    private get baseUrl(): string {
        const url = config.odoo.url;
        if (!url) throw new OdooUnavailableError('ODOO_URL is not configured');
        return url.replace(/\/$/, '');
    }

    /**
     * Resolve the Odoo UID for our service user. Cached for 24 h. Pass
     * `force=true` after a 401 to bust the cache and re-authenticate.
     */
    async authenticate(force = false): Promise<number> {
        if (!force && this.cachedUid && Date.now() - this.cachedUid.fetchedAt < UID_TTL_MS) {
            return this.cachedUid.uid;
        }

        const { db, username, apiKey } = config.odoo;
        if (!db || !username || !apiKey) {
            throw new OdooUnavailableError('Odoo credentials are not configured');
        }

        const payload = {
            jsonrpc: '2.0',
            method: 'call',
            params: {
                service: 'common',
                method: 'authenticate',
                // NB: we send the API key as the 3rd arg — that's Odoo's
                // convention for token-based auth. Real passwords work too,
                // we just never use them.
                args: [db, username, apiKey, {}],
            },
        };

        const data = await this.callJsonRpc(payload, 'common.authenticate');
        const uid = data?.result;

        if (typeof uid !== 'number' || uid <= 0) {
            // Odoo returns `false` for bad credentials. Treat as unavailable
            // so the controller surfaces a 503 — not the user's fault to fix.
            logger.error({ msg: 'Odoo authentication failed (no UID returned)', uid });
            throw new OdooUnavailableError('Odoo authentication failed');
        }

        this.cachedUid = { uid, fetchedAt: Date.now() };
        logger.info({ msg: 'Odoo authenticated', uid });
        return uid;
    }

    /**
     * Live search of `res.partner` companies by name (case-insensitive
     * substring). Returns up to `limit` rows ordered alphabetically.
     */
    async searchCompanies(query: string, limit = 20): Promise<OdooCompany[]> {
        const q = (query ?? '').trim();
        if (q.length < 2) return [];
        const safeLimit = Math.max(1, Math.min(20, limit | 0));

        const rows = await this.executeKw<OdooCompany[]>(
            'res.partner',
            'search_read',
            [[['is_company', '=', true], ['name', 'ilike', q]]],
            { fields: ['id', 'name', 'email', 'phone'], limit: safeLimit, order: 'name ASC' },
        );

        logger.info({ msg: 'Odoo searchCompanies', q, returned: rows.length });
        return rows;
    }

    /**
     * Read a single company by id. Used by the send-gate to verify that
     * the linked Odoo contact still exists at offer-send time.
     */
    async getCompanyById(id: number): Promise<OdooCompany | null> {
        if (!Number.isInteger(id) || id <= 0) return null;
        const rows = await this.executeKw<OdooCompany[]>(
            'res.partner',
            'read',
            [[id]],
            { fields: ['id', 'name', 'email', 'phone'] },
        );
        return rows[0] ?? null;
    }

    /**
     * Run an arbitrary Odoo model method.
     *
     * Exposed so services that write to Odoo — sales orders, reservation
     * references — go through the same path as the reads: one authentication
     * cache, one rate limiter, and the single re-auth-and-retry on an expired
     * session. A service holding its own JSON-RPC call would duplicate all
     * three and drift from them.
     */
    async call<T>(
        model: string,
        method: string,
        args: any[],
        kwargs: Record<string, any> = {},
    ): Promise<T> {
        return this.executeKw<T>(model, method, args, kwargs);
    }

    // ─── private helpers ─────────────────────────────────────────────────

    private async executeKw<T>(
        model: string,
        method: string,
        args: any[],
        kwargs: Record<string, any> = {},
    ): Promise<T> {
        const run = async (uid: number) => {
            const { db, apiKey } = config.odoo;
            const payload = {
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    service: 'object',
                    method: 'execute_kw',
                    args: [db, uid, apiKey, model, method, args, kwargs],
                },
            };
            return this.callJsonRpc(payload, `${model}.${method}`);
        };

        let uid = await this.authenticate();
        let data = await run(uid);

        // Odoo session expired or rotated under us — re-auth ONCE and retry.
        if (this.looksLikeAuthError(data)) {
            logger.warn({ msg: 'Odoo execute_kw rejected by auth; re-authenticating once' });
            this.cachedUid = null;
            uid = await this.authenticate(true);
            data = await run(uid);
        }

        if (data?.error) {
            const message = data.error?.data?.message ?? data.error?.message ?? 'Odoo error';
            const code = data.error?.data?.name ?? data.error?.code;
            throw new OdooApiError(message, code);
        }

        return data?.result as T;
    }

    /** Single HTTP call; wraps network/5xx into OdooUnavailableError. */
    private async callJsonRpc(payload: any, label: string): Promise<any> {
        return limiter.schedule(async () => {
            try {
                const res = await axios.post(`${this.baseUrl}/jsonrpc`, payload, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 10_000,
                });
                return res.data;
            } catch (err: any) {
                const status = err?.response?.status;
                logger.error({
                    msg: 'Odoo JSON-RPC call failed',
                    label,
                    status,
                    error: err?.message,
                });
                throw new OdooUnavailableError(
                    status ? `Odoo ${label} failed with HTTP ${status}` : `Odoo ${label} unreachable`,
                );
            }
        });
    }

    /**
     * Heuristic for "session expired / wrong UID" — Odoo signals this with
     * an AccessDenied or SessionExpired exception in the JSON-RPC error
     * object. We re-auth once before bubbling up.
     */
    private looksLikeAuthError(data: any): boolean {
        if (!data?.error) return false;
        const name = String(data.error?.data?.name ?? '');
        return /AccessDenied|SessionExpired|AccessError/i.test(name);
    }
}

export const odooClient = new OdooClientService();
export default odooClient;

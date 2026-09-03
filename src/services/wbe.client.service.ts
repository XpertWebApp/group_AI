import originalAxios from 'axios';
import Bottleneck from 'bottleneck';
import config from '../config';
import logger from '../utils/logger';
import { WBE_GLOBAL_RATE_LIMIT } from '../config/probeConfig';

// WBE UAT limit = 10 QPS, LIVE = 20 QPS.
// With reservoir approach, Bottleneck enforces an exact cap per second.
const rate = Math.max(1, Number(WBE_GLOBAL_RATE_LIMIT) || 10);

const limiter = new Bottleneck({
    reservoir: rate,                   // tokens available per interval
    reservoirRefreshAmount: rate,      // refill to `rate` tokens
    reservoirRefreshInterval: 1000,    // every 1 second
    maxConcurrent: Math.min(rate, 5),  // cap parallel HTTP connections
    minTime: Math.floor(1000 / rate),  // minimum gap between request starts
});

limiter.on('failed', async (error: any, jobInfo) => {
    if (error.response?.status === 429 && jobInfo.retryCount < 3) {
        logger.warn({ msg: 'WBE API 429 Rate Limit hit, retrying', retryCount: jobInfo.retryCount });
        return 1000; // wait 1s and retry
    }
});

// Circuit breaker — protects critical search/booking calls only.
// Non-critical calls (details, images, static data) DO NOT trip the breaker
// and bypass it entirely so they never affect an in-progress search.
const CIRCUIT_BREAKER_BLOCK_MS = 60 * 1000; // 60s (was 15 min — too aggressive)
let circuitBreakerBlockedUntil = 0;

interface ExecuteOpts {
    /** If true, this call neither trips the circuit breaker nor is blocked by it. */
    bypassCircuitBreaker?: boolean;
    /** Label for logs (e.g. 'getHotelDetails'). */
    label?: string;
}

const execute = async <T>(fn: () => Promise<T>, opts: ExecuteOpts = {}): Promise<T> => {
    // Bypass entirely for non-critical calls (e.g. hotel details)
    if (opts.bypassCircuitBreaker) {
        return limiter.schedule(fn);
    }

    if (Date.now() < circuitBreakerBlockedUntil) {
        throw new Error('Circuit Breaker Open: WBE API call blocked due to recent 401/403 error.');
    }
    try {
        return await limiter.schedule(fn);
    } catch (error: any) {
        if (error.response?.status === 401 || error.response?.status === 403) {
            circuitBreakerBlockedUntil = Date.now() + CIRCUIT_BREAKER_BLOCK_MS;
            logger.error({
                msg: `WBE API ${error.response?.status} Error. Trips circuit breaker for ${CIRCUIT_BREAKER_BLOCK_MS / 1000}s.`,
                status: error.response?.status,
                label: opts.label,
            });
        }
        throw error;
    }
};

// Default axios wrapper — uses circuit breaker (for critical search/booking calls)
const axios = {
    get: (...args: Parameters<typeof originalAxios.get>) => execute(() => originalAxios.get(...args)),
    post: (...args: Parameters<typeof originalAxios.post>) => execute(() => originalAxios.post(...args)),
};

// Non-critical axios wrapper — bypasses circuit breaker (for details, images, static CDN)
const axiosNonCritical = {
    get: (...args: Parameters<typeof originalAxios.get>) =>
        execute(() => originalAxios.get(...args), { bypassCircuitBreaker: true, label: 'non-critical' }),
    post: (...args: Parameters<typeof originalAxios.post>) =>
        execute(() => originalAxios.post(...args), { bypassCircuitBreaker: true, label: 'non-critical' }),
};

/**
 * Cutover safety guard.
 *
 * When `WBE_STATIC_ONLY_MODE=true` in env, the WBE client blocks every call
 * that would mutate a booking against the connected WBE environment
 * (search, book, voucher, cancel) and permits only read-only static-data
 * calls (destinations, hotels, images, currencies, nationalities, languages,
 * hotel details).
 *
 * Used during the LIVE cutover so LIVE credentials can be pointed at a local
 * dev DB for the sole purpose of a fresh static-data sync — with zero risk
 * of a real search or booking landing in the LIVE WBE ledger.
 *
 * Default: OFF. Setting is env-only; requires a server restart to change.
 */
const WBE_STATIC_ONLY_MODE = String(process.env.WBE_STATIC_ONLY_MODE || '').toLowerCase() === 'true';

function assertMutationsAllowed(operation: string): void {
    if (WBE_STATIC_ONLY_MODE) {
        const err = new Error(
            `WBE_STATIC_ONLY_MODE is on — operation "${operation}" is blocked. ` +
            `Only static-data sync calls are permitted. Unset WBE_STATIC_ONLY_MODE and restart the server to enable mutations.`
        );
        logger.error({ msg: 'WBE mutation blocked by WBE_STATIC_ONLY_MODE guard', operation });
        throw err;
    }
}

export class WbeClientService {
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly acceptLanguage: string;

    private readonly searchUrl: string;
    private readonly contentUrl: string;

    constructor() {
        this.apiKey = config.wbe.apiKey || '';
        this.baseUrl = config.wbe.baseUrl || '';
        this.searchUrl = (config.wbe as any).searchUrl || this.baseUrl;
        this.contentUrl = (config.wbe as any).contentUrl || 'https://uatcontent.wbeapi.com';
        this.acceptLanguage = (config.wbe as any).acceptLanguage || 'en';

        if (WBE_STATIC_ONLY_MODE) {
            logger.warn({
                msg: 'WBE client running in STATIC-ONLY mode — searches, bookings, vouchers and cancellations are blocked',
                searchUrl: this.searchUrl,
            });
        }
    }

    private getAuth() {
        return {
            username: (config.wbe as any).username,
            password: (config.wbe as any).password,
        };
    }

    private getDefaultHeaders() {
        return {
            'Accept-Language': this.acceptLanguage,
        };
    }

    /**
     * Legacy helper. Prefer `searchAndGetByHotelsV2` which matches WBE docs (POST /hotel/...).
     */
    async searchHotels(params: any) {
        try {
            const response = await axios.get(`${this.baseUrl}/api/Hotel/SearchAndGetByHotelsV2`, {
                params: {
                    ...params,
                    apiKey: this.apiKey,
                },
                auth: this.getAuth(),
                headers: this.getDefaultHeaders(),
            });
            return response.data;
        } catch (error: any) {
            logger.error({ msg: 'WBE API Search Error', error: error.message, params });
            throw error;
        }
    }

    /**
     * Legacy helper. Prefer `optionDetailsV2` which matches WBE docs (POST /hotel/...).
     */
    async getOptionDetails(tid: string) {
        try {
            const response = await axios.get(`${this.baseUrl}/api/Hotel/OptionDetailsV2`, {
                params: {
                    tid,
                    apiKey: this.apiKey,
                },
                auth: this.getAuth(),
                headers: this.getDefaultHeaders(),
            });
            return response.data;
        } catch (error: any) {
            logger.error({ msg: 'WBE API OptionDetails Error', error: error.message, tid });
            throw error;
        }
    }

    /**
     * Legacy helper. Prefer `getUpdatedOptionsV2` which matches WBE docs (POST /hotel/...).
     */
    async getUpdatedOptions(sessionId: string) {
        try {
            const response = await axios.get(`${this.baseUrl}/api/Hotel/GetUpdatedOptions`, {
                params: {
                    sessionId,
                    apiKey: this.apiKey,
                },
                auth: this.getAuth(),
                headers: this.getDefaultHeaders(),
            });
            return response.data;
        } catch (error: any) {
            logger.error({ msg: 'WBE API GetUpdatedOptions Error', error: error.message, sessionId });
            throw error;
        }
    }

    // Static Data APIs
    async getDestinations() {
        try {
            const response = await axios.get(`${this.baseUrl}/api/Hotel/destinations`, {
                params: { apiKey: this.apiKey },
                auth: this.getAuth(),
                headers: this.getDefaultHeaders(),
            });
            return response.data;
        } catch (error: any) {
            logger.error({ msg: 'WBE API GetDestinations Error', error: error.message });
            throw error;
        }
    }

    async getHotels() {
        try {
            const response = await axios.get(`${this.baseUrl}/api/hotel/Hotels`, {
                params: { apiKey: this.apiKey },
                auth: this.getAuth(),
                headers: this.getDefaultHeaders(),
            });
            return response.data;
        } catch (error: any) {
            logger.error({ msg: 'WBE API GetHotels Error', error: error.message });
            throw error;
        }
    }

    async getHotelDetails(url: string) {
        try {
            // WBE security update (2026-08): Hotel Details endpoint now requires the
            // same authentication as other XMLOut API calls — apiKey query param +
            // Basic Auth. Previously this was a public CDN endpoint with no auth.
            // Old (public) URLs return 404; a fresh Get Hotel List sync is required
            // to obtain the new authenticated HotelDetailsUrl values.
            //
            // Use non-critical wrapper — details calls must NEVER affect in-progress searches
            const response = await axiosNonCritical.get(url, {
                params: { apiKey: this.apiKey },
                auth: this.getAuth(),
                headers: this.getDefaultHeaders(),
            });
            return response.data;
        } catch (error: any) {
            logger.error({ msg: 'WBE API GetHotelDetails Error', error: error.message, url });
            throw error;
        }
    }

    async getLanguages() {
        try {
            const response = await axios.get(`https://uat.wbeapi.com/api/hotel/languages`, {
                params: { apiKey: this.apiKey },
                auth: this.getAuth(),
                headers: this.getDefaultHeaders(),
            });
            // Response is usually in the standard envelope: { Data, Success, ... }
            return response.data;
        } catch (error: any) {
            logger.error({ msg: 'WBE API GetLanguages Error', error: error.message });
            throw error;
        }
    }

    async getCurrencies() {
        try {
            const response = await axios.get(`${this.baseUrl}/api/hotel/currencies`, {
                params: { apiKey: this.apiKey },
                auth: this.getAuth(),
                headers: this.getDefaultHeaders(),
            });
            return response.data;
        } catch (error: any) {
            logger.error({ msg: 'WBE API GetCurrencies Error', error: error.message });
            throw error;
        }
    }

    async getNationalities() {
        try {
            const response = await axios.get(`${this.baseUrl}/api/hotel/nationalities`, {
                params: { apiKey: this.apiKey },
                auth: this.getAuth(),
                headers: this.getDefaultHeaders(),
            });
            return response.data;
        } catch (error: any) {
            logger.error({ msg: 'WBE API GetNationalities Error', error: error.message });
            throw error;
        }
    }

    /**
     * Fetch a hotel image by imageKey token.
     * Primary: WBE content CDN (uatcontent.wbeapi.com/Image/getimage?pic=...)
     * Fallback: legacy WBE Image API endpoints (staticuat / production).
     */
    async getHotelImage(imageKey: string): Promise<{ data: Buffer; contentType: string } | null> {
        // Primary — WBE content CDN (no auth required, publicly accessible)
        // Use non-critical wrapper — image fetches must NEVER affect in-progress searches
        try {
            const response = await axiosNonCritical.get(`${this.contentUrl}/Image/getimage`, {
                params: { pic: imageKey },
                responseType: 'arraybuffer',
                timeout: 10000,
            });
            if (response.status === 200 && response.data?.byteLength > 0) {
                const contentType = response.headers['content-type'] ?? 'image/jpeg';
                return { data: Buffer.from(response.data), contentType };
            }
        } catch (err: any) {
            logger.warn({ msg: 'WBE content CDN image fetch failed, trying legacy endpoints', error: err.message });
        }

        // Fallback — legacy WBE Image API (may not work in UAT)
        const legacyUrls = [
            `${this.baseUrl}/api/Hotel/Image?imageKey=${encodeURIComponent(imageKey)}&apiKey=${this.apiKey}`,
            `https://wbeapi.com/api/Hotel/Image?imageKey=${encodeURIComponent(imageKey)}&apiKey=${this.apiKey}`,
        ];

        for (const url of legacyUrls) {
            try {
                const response = await axiosNonCritical.get(url, {
                    auth: this.getAuth(),
                    headers: { ...this.getDefaultHeaders(), Accept: 'image/*' },
                    responseType: 'arraybuffer',
                    timeout: 8000,
                });
                if (response.status === 200 && response.data?.byteLength > 0) {
                    const contentType = response.headers['content-type'] ?? 'image/jpeg';
                    return { data: Buffer.from(response.data), contentType };
                }
            } catch {
                // try next URL
            }
        }
        return null;
    }

    /**
     * Matches docs: POST /hotel/SearchAndGetByHotelsV2?apiKey=...
     * Body contains HotelIds, CheckInDate, Nights, CurrencyCode, NationalityCode, WaitSeconds, Rooms.
     * NOTE: WBE uses "WaitSeconds" (capital S) — confirmed from API spec.
     */
    async searchAndGetByHotelsV2(body: any) {
        try {
            const response = await axios.post(
                `${this.searchUrl}/hotel/SearchAndGetByHotelsV2`,
                body,
                {
                    params: { apiKey: this.apiKey },
                    auth: this.getAuth(),
                    headers: this.getDefaultHeaders(),
                }
            );
            return response.data;
        } catch (error: any) {
            // fallback to legacy path if server only supports /api/Hotel/...
            if (error.response?.status === 404) {
                const response = await axios.post(
                    `${this.searchUrl}/api/Hotel/SearchAndGetByHotelsV2`,
                    body,
                    {
                        params: { apiKey: this.apiKey },
                        auth: this.getAuth(),
                        headers: this.getDefaultHeaders(),
                    }
                );
                return response.data;
            }
            logger.error({ msg: 'WBE API SearchAndGetByHotelsV2 Error', error: error.message, body });
            throw error;
        }
    }

    /**
     * Matches docs: POST /hotel/optionDetailsV2?apiKey=...
     * Body: { SessionID, TID, HotelCode, Prebook?, OptionalExtras? }
     *
     * `Prebook` is passed straight through from `body`:
     *   - omitted / false → repeatable read of the option details.
     *   - true            → revalidates the option and RESERVES it upstream.
     *                       Mandatory exactly once before bookV2, and WBE
     *                       rejects a second Prebook=true for the same flow.
     *
     * Callers must not set Prebook=true speculatively — go through
     * wbeBooking.service, which owns the once-only guard.
     */
    async optionDetailsV2(body: any) {
        // Prebook=true reserves the option on WBE's side — treat as a mutation.
        if (body?.Prebook === true) {
            assertMutationsAllowed('optionDetailsV2(Prebook=true)');
        }
        try {
            const response = await axios.post(
                `${this.searchUrl}/hotel/optionDetailsV2`,
                body,
                {
                    params: { apiKey: this.apiKey },
                    auth: this.getAuth(),
                    headers: this.getDefaultHeaders(),
                }
            );
            return response.data;
        } catch (error: any) {
            if (error.response?.status === 404) {
                const response = await axios.post(
                    `${this.searchUrl}/api/Hotel/OptionDetailsV2`,
                    body,
                    {
                        params: { apiKey: this.apiKey },
                        auth: this.getAuth(),
                        headers: this.getDefaultHeaders(),
                    }
                );
                return response.data;
            }
            logger.error({ msg: 'WBE API OptionDetailsV2 Error', error: error.message, body });
            throw error;
        }
    }

    /**
     * Matches docs: POST /hotel/GetUpdatedOptions?apiKey=...
     * Body: { SessionID, HotelId }
     */
    async getUpdatedOptionsV2(body: any) {
        try {
            const response = await axios.post(
                `${this.searchUrl}/hotel/GetUpdatedOptions`,
                body,
                {
                    params: { apiKey: this.apiKey },
                    auth: this.getAuth(),
                    headers: this.getDefaultHeaders(),
                }
            );
            return response.data;
        } catch (error: any) {
            if (error.response?.status === 404) {
                const response = await axios.post(
                    `${this.searchUrl}/api/Hotel/GetUpdatedOptions`,
                    body,
                    {
                        params: { apiKey: this.apiKey },
                        auth: this.getAuth(),
                        headers: this.getDefaultHeaders(),
                    }
                );
                return response.data;
            }
            logger.error({ msg: 'WBE API GetUpdatedOptionsV2 Error', error: error.message, body });
            throw error;
        }
    }

    // ── Booking operations (XMLOUT) ──────────────────────────────────────────
    // These mutate real reservations and, on a LIVE account, real money.
    //
    // Deliberate difference from the search calls above: bookV2 does NOT retry
    // on 404. The other endpoints fall back to the legacy `/api/Hotel/...`
    // path on 404, which is safe for reads but not for a write — a request
    // that timed out or returned an ambiguous error may still have created a
    // reservation upstream, and a blind retry would double-book. Recovery is
    // handled by bookingDetailsByAgencyReference() instead, which is why
    // AgencyReference must be unique and generated before dispatch.

    /**
     * Matches docs: POST /hotel/bookV2?apiKey=...
     * Body: { SessionID, TID, HotelCode, PaymentOption, AgencyReference,
     *         HotelNotes?, CarbonCopyMail?, IssueVoucher?, Rooms[], OptionalExtras? }
     *
     * Requires optionDetailsV2 to have been called once with Prebook=true for
     * this option. A response without Data.BookingReference means no booking
     * was made; the reason is in `Messages`.
     *
     * NOT retried on failure — see the note above.
     */
    async bookV2(body: any) {
        assertMutationsAllowed('bookV2');
        try {
            const response = await axios.post(
                `${this.searchUrl}/hotel/bookV2`,
                body,
                {
                    params: { apiKey: this.apiKey },
                    auth: this.getAuth(),
                    headers: this.getDefaultHeaders(),
                }
            );
            return response.data;
        } catch (error: any) {
            // Log the agency reference so an ambiguous failure can be
            // reconciled against WBE via bookingDetailsByAgencyReference().
            logger.error({
                msg: 'WBE API BookV2 Error',
                error: error.message,
                status: error.response?.status,
                agencyReference: body?.AgencyReference,
                tid: body?.TID,
                hotelCode: body?.HotelCode,
                wbeResponse: error.response?.data,
            });
            throw error;
        }
    }

    /**
     * Matches docs: GET /hotel/bookingDetails?bookingReference=...&apiKey=...
     * Read-only status sync; safe to call repeatedly.
     */
    async bookingDetails(bookingReference: string) {
        try {
            const response = await axios.get(
                `${this.searchUrl}/hotel/bookingDetails`,
                {
                    params: { bookingReference, apiKey: this.apiKey },
                    auth: this.getAuth(),
                    headers: this.getDefaultHeaders(),
                }
            );
            return response.data;
        } catch (error: any) {
            logger.error({ msg: 'WBE API BookingDetails Error', error: error.message, bookingReference });
            throw error;
        }
    }

    /**
     * Same endpoint as bookingDetails but looked up by our own AgencyReference.
     *
     * This is the crash-recovery path: if bookV2 times out or errors after WBE
     * has already created the reservation, we hold no bookingReference. Since
     * AgencyReference is ours and generated before dispatch, it is the only
     * handle we have to find out whether the booking actually exists.
     */
    async bookingDetailsByAgencyReference(agencyReference: string) {
        try {
            const response = await axios.get(
                `${this.searchUrl}/hotel/bookingDetails`,
                {
                    params: { agencyReference, apiKey: this.apiKey },
                    auth: this.getAuth(),
                    headers: this.getDefaultHeaders(),
                }
            );
            return response.data;
        } catch (error: any) {
            logger.error({
                msg: 'WBE API BookingDetails (by agencyReference) Error',
                error: error.message,
                agencyReference,
            });
            throw error;
        }
    }

    /**
     * Matches docs: POST /hotel/issueVoucher?bookingReference=...&apiKey=...
     * Empty body. Valid only for a Confirmed booking; result is Vouchered.
     */
    async issueVoucher(bookingReference: string) {
        assertMutationsAllowed('issueVoucher');
        try {
            // `{}` rather than null for the same reason as cancelBookingV2:
            // axios omits Content-Type on a null body and WBE returns 415.
            const response = await axios.post(
                `${this.searchUrl}/hotel/issueVoucher`,
                {},
                {
                    params: { bookingReference, apiKey: this.apiKey },
                    auth: this.getAuth(),
                    headers: this.getDefaultHeaders(),
                }
            );
            return response.data;
        } catch (error: any) {
            logger.error({ msg: 'WBE API IssueVoucher Error', error: error.message, bookingReference });
            throw error;
        }
    }

    /**
     * Matches docs: POST /hotel/CancelBookingV2?bookingReference=...&apikey=...
     * Empty body.
     *
     * Note the lowercase `apikey` — CancelBookingV2 is documented with a
     * different casing to every other endpoint. Both spellings are sent so the
     * call works whichever one WBE's router actually honours.
     *
     * Outcomes (per docs): CLX with Price 0 = cancelled free of charge;
     * CLX with a Price = cancelled with an agency charge; PNDC = could not be
     * settled automatically and needs manual confirmation on WBE's side.
     * A failed cancellation also lands in PNDC rather than staying booked.
     */
    async cancelBookingV2(bookingReference: string) {
        assertMutationsAllowed('cancelBookingV2');
        try {
            // An empty object, not null: axios sends no Content-Type for a null
            // body and WBE answers 415. The endpoint takes its arguments from
            // the query string (see swagger: bookingReference, no requestBody),
            // so the body only has to be present, not populated.
            const response = await axios.post(
                `${this.searchUrl}/hotel/CancelBookingV2`,
                {},
                {
                    // `apiKey` only. Sending the lowercase `apikey` alongside it
                    // makes WBE reject the request with 401 — every other call
                    // here passes the camelCase spelling on its own.
                    params: { bookingReference, apiKey: this.apiKey },
                    auth: this.getAuth(),
                    headers: this.getDefaultHeaders(),
                }
            );
            return response.data;
        } catch (error: any) {
            logger.error({
                msg: 'WBE API CancelBookingV2 Error',
                error: error.message,
                bookingReference,
                wbeResponse: error.response?.data,
            });
            throw error;
        }
    }
}

export default new WbeClientService();

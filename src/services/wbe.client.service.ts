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
            // Use non-critical wrapper — details calls must NEVER affect in-progress searches
            const response = await axiosNonCritical.get(url, {
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
     * Body: { SessionID, TID, HotelCode, OptionalExtras? }
     */
    async optionDetailsV2(body: any) {
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
}

export default new WbeClientService();

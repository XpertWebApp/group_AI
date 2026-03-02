import axios from 'axios';
import config from '../config';
import logger from '../utils/logger';

export class WbeClientService {
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly acceptLanguage: string;

    constructor() {
        this.apiKey = config.wbe.apiKey || '';
        this.baseUrl = config.wbe.baseUrl || '';
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
            const response = await axios.get(url, {
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
     * Matches docs: POST /hotel/SearchAndGetByHotelsV2?apiKey=...
     * Body contains HotelIds, CheckInDate, Nights, CurrencyCode, NationalityCode, WaitSeconds, Rooms.
     */
    async searchAndGetByHotelsV2(body: any) {
        try {
            const response = await axios.post(
                `${this.baseUrl}/hotel/SearchAndGetByHotelsV2`,
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
                    `${this.baseUrl}/api/Hotel/SearchAndGetByHotelsV2`,
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
                `${this.baseUrl}/hotel/optionDetailsV2`,
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
                    `${this.baseUrl}/api/Hotel/OptionDetailsV2`,
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
                `${this.baseUrl}/hotel/GetUpdatedOptions`,
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
                    `${this.baseUrl}/api/Hotel/GetUpdatedOptions`,
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

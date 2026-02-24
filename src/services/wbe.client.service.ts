import axios from 'axios';
import config from '../config';
import logger from '../utils/logger';

export class WbeClientService {
    private readonly apiKey: string;
    private readonly baseUrl: string;

    constructor() {
        this.apiKey = config.wbe.apiKey || '';
        this.baseUrl = config.wbe.baseUrl || '';
    }

    async searchHotels(params: any) {
        try {
            const response = await axios.get(`${this.baseUrl}/api/Hotel/SearchAndGetByHotelsV2`, {
                params: {
                    ...params,
                    apiKey: this.apiKey,
                },
            });
            return response.data;
        } catch (error: any) {
            logger.error({ msg: 'WBE API Search Error', error: error.message, params });
            throw error;
        }
    }

    async getOptionDetails(tid: string) {
        try {
            const response = await axios.get(`${this.baseUrl}/api/Hotel/OptionDetailsV2`, {
                params: {
                    tid,
                    apiKey: this.apiKey,
                },
            });
            return response.data;
        } catch (error: any) {
            logger.error({ msg: 'WBE API OptionDetails Error', error: error.message, tid });
            throw error;
        }
    }

    async getUpdatedOptions(sessionId: string) {
        try {
            const response = await axios.get(`${this.baseUrl}/api/Hotel/GetUpdatedOptions`, {
                params: {
                    sessionId,
                    apiKey: this.apiKey,
                },
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
                params: { apiKey: this.apiKey },
            });
            return response.data;
        } catch (error: any) {
            logger.error({ msg: 'WBE API GetHotelDetails Error', error: error.message, url });
            throw error;
        }
    }
}

export default new WbeClientService();

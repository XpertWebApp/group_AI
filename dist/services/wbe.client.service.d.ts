export declare class WbeClientService {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly acceptLanguage;
    private readonly searchUrl;
    private readonly contentUrl;
    constructor();
    private getAuth;
    private getDefaultHeaders;
    /**
     * Legacy helper. Prefer `searchAndGetByHotelsV2` which matches WBE docs (POST /hotel/...).
     */
    searchHotels(params: any): Promise<any>;
    /**
     * Legacy helper. Prefer `optionDetailsV2` which matches WBE docs (POST /hotel/...).
     */
    getOptionDetails(tid: string): Promise<any>;
    /**
     * Legacy helper. Prefer `getUpdatedOptionsV2` which matches WBE docs (POST /hotel/...).
     */
    getUpdatedOptions(sessionId: string): Promise<any>;
    getDestinations(): Promise<any>;
    getHotels(): Promise<any>;
    getHotelDetails(url: string): Promise<any>;
    getLanguages(): Promise<any>;
    getCurrencies(): Promise<any>;
    getNationalities(): Promise<any>;
    /**
     * Fetch a hotel image by imageKey token.
     * Primary: WBE content CDN (uatcontent.wbeapi.com/Image/getimage?pic=...)
     * Fallback: legacy WBE Image API endpoints (staticuat / production).
     */
    getHotelImage(imageKey: string): Promise<{
        data: Buffer;
        contentType: string;
    } | null>;
    /**
     * Matches docs: POST /hotel/SearchAndGetByHotelsV2?apiKey=...
     * Body contains HotelIds, CheckInDate, Nights, CurrencyCode, NationalityCode, WaitSeconds, Rooms.
     * NOTE: WBE uses "WaitSeconds" (capital S) — confirmed from API spec.
     */
    searchAndGetByHotelsV2(body: any): Promise<any>;
    /**
     * Matches docs: POST /hotel/optionDetailsV2?apiKey=...
     * Body: { SessionID, TID, HotelCode, OptionalExtras? }
     */
    optionDetailsV2(body: any): Promise<any>;
    /**
     * Matches docs: POST /hotel/GetUpdatedOptions?apiKey=...
     * Body: { SessionID, HotelId }
     */
    getUpdatedOptionsV2(body: any): Promise<any>;
}
declare const _default: WbeClientService;
export default _default;

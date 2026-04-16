export declare class StaticDataService {
    constructor();
    private syncDestinationRecursive;
    syncDestinations(): Promise<void>;
    syncLanguages(): Promise<void>;
    syncCurrencies(): Promise<void>;
    syncNationalities(): Promise<void>;
    syncHotelsList(): Promise<void>;
    syncHotelDetails(): Promise<void>;
    fullSync(): Promise<void>;
}
declare const _default: StaticDataService;
export default _default;

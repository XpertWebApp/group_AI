/**
 * GIATA API Client Service
 *
 * HTTP client for both GIATA MHG (Multilingual Hotel Guide) and Multicodes APIs.
 * MHG provides: texts, images, fact sheets per hotel.
 * Multicodes provides: property identification, supplier code mappings, geo data.
 *
 * Auth: HTTP Basic with format username|company : password
 * Response: XML → parsed to JS objects via fast-xml-parser
 */
export interface GiataTextSection {
    sectionType: string;
    title: string;
    content: string;
}
export interface GiataTextResult {
    giataId: string;
    lang: string;
    lastUpdate: string | null;
    sections: GiataTextSection[];
}
export interface GiataImageSize {
    maxwidth: string;
    width: string;
    height: string;
    filesize: string;
    url: string;
}
export interface GiataImage {
    type: string;
    lastUpdate: string | null;
    sizes: GiataImageSize[];
}
export interface GiataImageResult {
    giataId: string;
    images: GiataImage[];
}
export interface GiataFactValue {
    value: string;
    unit?: string;
    fee?: boolean;
    name?: string;
}
export interface GiataFact {
    sectionType: string;
    sectionName: string;
    factId: number;
    factName: string;
    typeHint: string;
    values: GiataFactValue[];
}
export interface GiataFactResult {
    giataId: string;
    lastUpdate: string | null;
    facts: GiataFact[];
}
export interface GiataProviderCode {
    providerCode: string;
    providerType: string;
    codeValues: string[];
}
export interface GiataPropertyResult {
    giataId: string;
    name: string;
    city: string;
    country: string;
    lastUpdate: string | null;
    providers: GiataProviderCode[];
    latitude?: number;
    longitude?: number;
    category?: string;
}
export interface GiataListItem {
    giataId: string;
    lastUpdate: string;
}
declare class GiataClientService {
    private mhgClient;
    private multicodesClient;
    constructor();
    /** Check if GIATA credentials are configured. */
    isConfigured(): boolean;
    /** Fetch hotel texts in a given language (e.g. "en", "de"). */
    getTexts(lang: string, giataId: string): Promise<GiataTextResult | null>;
    /** Fetch all images for a hotel. */
    getImages(giataId: string): Promise<GiataImageResult | null>;
    /** Fetch structured fact sheet for a hotel. */
    getFactSheet(giataId: string): Promise<GiataFactResult | null>;
    /** List GIATA IDs modified since a given date. */
    getItemsChangedSince(since: string): Promise<GiataListItem[]>;
    /** Fetch full property details from Multicodes (address, providers, geo, chains). */
    getPropertyDetails(giataId: string): Promise<GiataPropertyResult | null>;
    /** Get list of properties that have been moved/merged since a date. */
    getMovedProperties(since?: string): Promise<Array<{
        oldGiataId: string;
        newGiataId: string;
        movedOn: string;
    }>>;
    /** Try to find a GIATA ID by looking up a supplier/GDS code in Multicodes. */
    resolveByGds(providerCode: string, hotelCode: string): Promise<string | null>;
}
declare const _default: GiataClientService;
export default _default;

import type { ExpandedRoom, RoomTypeProbeTarget } from '../queue/hotelProbeJob.types';
export interface HotelSearchParams {
    /** Filter by meal type. 'BB' = breakfast, 'RO' = room only. Omit to accept all. */
    mealType?: string;
    /** If true, also search hotels at starRating ±1. Default: true. */
    includeAlternativeStars?: boolean;
    /** WBE API wait seconds. Default: 35. */
    waitSeconds?: number;
    /** Currency override. Falls back to request currency. */
    currencyCode?: string;
    /** Nationality override. Falls back to request nationalityCode. */
    nationalityCode?: string;
    /** Filter hotels by facility/amenity IDs. Only hotels with ALL listed facilities are included. */
    facilityIds?: number[];
}
export interface ProcessedOption {
    tid: string;
    supplierCode: string;
    /** Price per room per night, normalised from WBE response (TotalPrice ÷ SEARCH_ROOMS ÷ nights). */
    pricePerRoomPerNight: number;
    /** Raw total price returned by WBE for the searched configuration. */
    rawTotalPrice: number;
    currency: string;
    freeCancellation: boolean;
    /** false = instant confirm; true = on-request (slower). Groups should prefer false. */
    onRequest: boolean;
    mealType: string;
    mealName: string;
    /** Room description(s) from WBE Rooms array. */
    roomDescriptions: string[];
    cancelDeadline?: string | null;
    /** Max rooms this supplier can provide for a group booking. */
    maxRoomsFromSupplier: number;
    /** Provider (hotel's native) price before markup. */
    providerPrice?: number;
    providerCurrency?: string;
    /** Whether WBE flagged this option as needing a GetUpdatedOptions refresh. */
    updatedOptionsNeeded: boolean;
}
export interface SupplierSplit {
    supplierCode: string;
    tid: string;
    rooms: number;
    pricePerRoomPerNight: number;
    currency: string;
}
/**
 * A flat summary of the best (cheapest mid-range) option for a hotel.
 * Exposed on each HotelResult for easy frontend consumption.
 */
export interface HotelBestOption {
    tid: string;
    sessionId: string;
    supplierCode: string;
    buyingPricePerRoomPerNight: number;
    currency: string;
    freeCancellation: boolean;
    cancelDeadline: string | null;
    mealType: string;
    mealName: string;
    roomDescriptions: string[];
}
export interface HotelResult {
    hotelCode: string;
    hotelName: string;
    description?: string | null;
    starRating?: number | null;
    imageUrl?: string | null;
    address?: string | null;
    addressCity?: string | null;
    addressCountry?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    sessionId: string;
    /**
     * include  – hotel can confidently fulfill the requested room count
     * flag     – risky (inventory overlap likely), include as secondary option
     * omit     – cannot fulfill the group size
     */
    status: 'include' | 'flag' | 'omit';
    /** Physical room count from WBE static DB. Used for overlap check. */
    totalRooms?: number | null;
    /** Effective rooms this hotel can contribute after overlap check (Steps 3.1–3.2). */
    roomsAllocated?: number;
    /** True when hotel.total_rooms is unknown — offer should be flagged (EC4). */
    inventoryOverlapFlag?: boolean;
    /** Sum of maxRooms across all usable, group-allowed suppliers for this hotel. */
    totalAvailableRooms: number;
    /** The highest mid-range price per room per night (used as buying price base). */
    highestMidRangePrice?: number;
    currency?: string;
    /**
     * Flat summary of the best option — what the frontend needs to show a result card
     * and to call option-details. Uses the cheapest mid-range option.
     */
    bestOption?: HotelBestOption;
    /** All options that passed free-cxl + meal-type + group-allowed + not-on-request filter. */
    usableOptions: ProcessedOption[];
    /** Options selected in the mid-range band (excluding bottom/top 20%). */
    selectedOptions: ProcessedOption[];
    /** Internal supplier split plan (NEVER expose to customer). */
    supplierSplit: SupplierSplit[];
    /** Human-readable note for operators. */
    note?: string;
}
export interface HotelSearchResponse {
    requestId: string;
    sessionId: string;
    finished: boolean;
    totalRoomsRequested: number;
    results: HotelResult[];
    /** Hotels at alternative star ratings (±1 from requested). */
    alternativeResults: HotelResult[];
    /** Summary stats for the agent UI. */
    summary: {
        total: number;
        included: number;
        flagged: number;
        omitted: number;
    };
}
/**
 * Returned by searchForRequest and generateAutoOffer after the new queue-based flow.
 * The actual hotel results arrive asynchronously via SSE / polling.
 */
export interface HotelSearchQueueResponse {
    requestId: string;
    totalCandidates: number;
    jobsQueued: number;
    message: string;
    /** Subscribe for real-time hotel-level updates. */
    sseEndpoint: string;
    /** Poll this endpoint if SSE is not available. */
    statusEndpoint: string;
}
/** One accepted hotel in the auto-generated offer. */
export interface AutoOfferHotel {
    hotelCode: string;
    hotelName: string;
    starRating: number | null;
    imageUrl: string | null;
    address: string | null;
    addressCity: string | null;
    addressCountry: string | null;
    roomsAllocated: number;
    /** Earliest cancellation deadline across all A2 supplier entries. */
    cxlDeadline: string | null;
    /** True when hotel.total_rooms is unknown — offer should note unverified inventory. */
    inventoryOverlapFlag: boolean;
    note?: string;
    /** Internal supplier split — NEVER expose to customer (Oliver's Rule 3). */
    supplierSplit: SupplierSplit[];
}
/** Result of the full accumulation loop (Steps 2–4 from the PDF). */
export interface AutoOfferResult {
    success: boolean;
    requestId: string;
    roomsNeeded: number;
    roomsCommitted: number;
    currency: string;
    nights: number;
    validatedHotels: AutoOfferHotel[];
    /** Highest mid-band supplier price across ALL A2 splits (buying price base). */
    buyingPriceBase?: number;
    /** Unified sell price per room per night shown to the customer. */
    sellingPricePerRoomPerNight?: number;
    /** Total offer price = sellingPrice × roomsNeeded × nights. */
    totalOfferPrice?: number;
    markupPercent?: number;
    escalation?: {
        roomsMissing: number;
        partialHotels: AutoOfferHotel[];
        suggestion: string;
    };
}
export interface CancellationCondition {
    fromDate: string;
    toDate: string;
    amount: number;
    currency: string;
    text: string;
}
export interface CancellationPolicy {
    nonRefundable: boolean;
    deadline: string | null;
    conditions: CancellationCondition[];
    comment: string | null;
}
export interface RoomDayPrice {
    date: string;
    price: number;
}
export interface OptionDetailsResponse {
    tid: string;
    hotelCode: string;
    cached: boolean;
    /** Raw API response (full, for debugging). */
    data: any;
    /** Structured, parsed fields ready for frontend use. */
    parsed: {
        nonRefundable?: boolean;
        cxlDeadline?: string | null;
        mealType?: string;
        mealName?: string;
        daypricesTotal?: number;
        daypricesCurrency?: string;
        providerPrice?: number;
        essentialInfo?: string;
        /** Per-room, per-night price breakdown. */
        roomBreakdown?: Array<{
            roomId: number;
            description: string;
            prices: RoomDayPrice[];
        }>;
        /** Clean cancellation policy object. */
        cancellationPolicy?: CancellationPolicy;
        supplements?: any[];
    };
}
/**
 * Expand the booking request rooms JSON into a flat ordered list of individual rooms.
 * e.g. { double: 3, single: 1 } → [2-adult, 2-adult, 2-adult, 1-adult]
 * Used by buildProbeBatch to compose the Rooms array for each probe call.
 */
export declare function expandRequestRooms(rooms: any): ExpandedRoom[];
/**
 * Build per-room-type probe targets from the booking request rooms JSON.
 * Each room type gets its own target with probeLimit = requested × PROBE_MULTIPLIER.
 * e.g. { single: 5, double: 10 } → [
 *   { roomType: 'single', requested: 5, probeLimit: 10, adults: 1, ... },
 *   { roomType: 'double', requested: 10, probeLimit: 20, adults: 2, ... },
 * ]
 */
export declare function buildRoomTypeTargets(rooms: any): RoomTypeProbeTarget[];
/**
 * Build the WBE Rooms array for one probe batch.
 * startRoomId is 1-based (R1 = first room, R4 = second batch, etc.).
 * Room composition cycles through expandedRooms so the adults/children
 * match the actual group composition.
 */
export declare function buildProbeBatch(expandedRooms: ExpandedRoom[], startRoomId: number, batchSize?: number): Array<{
    RoomID: number;
    AdultsNo: string;
    ChildrenNo: string;
    ChildrenAges: number[];
}>;
export declare class HotelSearchService {
    /**
     * Queue-based hotel search orchestration for a booking request.
     *
     * Dispatches one HotelProbeJob per candidate hotel to RabbitMQ.
     * Each job probes R1-R3, R4-R6, R7-R9 … sequentially until capacity is confirmed.
     * Returns immediately — results arrive via SSE (GET /requests/:id/hotel-search/events)
     * or polling (GET /requests/:id/hotel-search/status).
     */
    searchForRequest(requestId: string, params?: HotelSearchParams): Promise<HotelSearchQueueResponse>;
    /**
     * Polls GetUpdatedOptions until Finished: true or timeout.
     * Used for both session-level (Finished: false) and per-option (UpdatedOptionsNeeded: true) polling.
     * Returns the hotel entries from the poll response.
     */
    private pollUntilFinished;
    /**
     * Fetch option details for one or more TIDs and cache the results.
     *
     * Step 6 from the guide: "Get Detailed Pricing (OptionDetailsV2)"
     * Returns per-night price breakdown + cancellation policy.
     */
    fetchOptionDetails(selections: Array<{
        sessionId: string;
        tid: string;
        hotelCode: string;
    }>): Promise<OptionDetailsResponse[]>;
    /**
     * Webhook-triggered auto offer — queue-based version.
     *
     * Dispatches one HotelProbeJob per candidate hotel (primary stars first, then
     * alternatives). Each job runs R1-R3 → R4-R6 → … probes sequentially in the
     * worker and emits SSE events as results arrive. Returns immediately.
     *
     * Used by offerGeneration.service.ts for webhook-triggered auto offers.
     */
    generateAutoOffer(requestId: string, params?: HotelSearchParams & {
        markupPercent?: number;
    }): Promise<HotelSearchQueueResponse>;
    /**
     * Calculate the recommended customer sell price for a hotel.
     *
     * Step 7 from the guide:
     *   1. Take the highest mid-range supplier buying price
     *   2. Apply markup (15-20%)
     *   3. Apply price psychology (avoid round numbers)
     */
    calculateSellPrice(buyingPrice: number, markupPercent?: number): {
        buyingPrice: number;
        sellPrice: number;
        markupPercent: number;
    };
}
declare const _default: HotelSearchService;
export default _default;

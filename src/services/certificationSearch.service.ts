import wbeClientService from './wbe.client.service';
import hotelSearchRepository from '../repositories/hotelSearch.repository';
import logger from '../utils/logger';

/**
 * Raw WBE availability search for XMLOUT certification.
 *
 * Why this exists separately from hotelSearch.service:
 *
 * The main search pipeline is built for SETT's group-travel product. It always
 * probes with a fixed room composition (SEARCH_ROOMS = 3, two adults each — per
 * Oliver's rule), never carries children, then filters options down to free
 * cancellation, allowed suppliers and a mid-range price band before applying
 * markup. Every one of those steps is correct for the product and wrong for
 * certification, which has to prove the WBE contract itself: exact room
 * composition in, unmodified supplier options out.
 *
 * Children are the sharpest example. The group pipeline hardcodes `children: 0`
 * — not as a business rule, but because children never enter the system: the
 * request form, the Wix webhook, the Zod schemas and the BookingRequest model
 * all have no children field. WBE's certification scenarios, however, put
 * children in 8 of 14 cases. Rather than retrofit child intake through the
 * whole request flow (a product change, not a certification one), this service
 * takes the composition directly from its caller.
 *
 * Nothing here is reachable from the group flow, and this module deliberately
 * imports nothing from hotelSearch.service, so the live pipeline cannot be
 * affected by changes made for certification.
 */

/** WBE caps a single search — and therefore a single booking — at 9 rooms. */
export const MAX_ROOMS_PER_SEARCH = 9;

/** WBE accepts at most 100 hotel codes per search call. */
const MAX_HOTEL_IDS_PER_CALL = 100;

/** How long WBE should hold the request open before returning a first batch. */
const DEFAULT_WAIT_SECONDS = 15;

/** Poll interval while WBE reports Finished: false (ms). */
const POLL_INTERVAL_MS = 3000;

/** Upper bound on total polling per search (ms). */
const MAX_POLL_WAIT_MS = 60_000;

/** One room's exact occupancy, as WBE is to receive it. */
export interface CertificationRoomInput {
    adults: number;
    /** Ages of each child in this room; length must equal the child count. */
    childrenAges?: number[];
}

export interface CertificationSearchParams {
    /** Hotel codes to search. Mutually exclusive with destinationId. */
    hotelCodes?: string[];
    /** Resolve hotel codes from this destination instead of passing them. */
    destinationId?: number;
    /** Star filter used only when resolving by destination. */
    starRatings?: number[];
    /** Cap on resolved hotel codes when searching by destination. */
    hotelLimit?: number;
    /** Check-in date, ISO `YYYY-MM-DD`. */
    checkInDate: string;
    nights: number;
    rooms: CertificationRoomInput[];
    currencyCode?: string;
    nationalityCode?: string;
    /** Restrict results to a meal plan (e.g. 'RO'). Omit to accept all. */
    mealType?: string;
    waitSeconds?: number;
}

/** A single bookable option, exactly as WBE described it. */
export interface CertificationOption {
    tid: string;
    totalPrice: number;
    currency: string;
    mealType?: string;
    mealName?: string;
    /** True when WBE will not confirm instantly. */
    onRequest: boolean;
    /** True when GetUpdatedOptions must be called before relying on this. */
    updatedOptionsNeeded: boolean;
    supplierCode?: string;
    rooms: Array<{ roomId: number; description?: string }>;
}

export interface CertificationHotelResult {
    hotelCode: string;
    hotelName?: string;
    destinationId?: number;
    destinationName?: string;
    options: CertificationOption[];
}

export interface CertificationSearchResult {
    /** Required, with the TID, for every downstream option/booking call. */
    sessionId: string;
    checkInDate: string;
    checkOutDate: string;
    nights: number;
    /** The room composition as actually sent to WBE. */
    roomsRequested: Array<{ roomId: number; adults: number; children: number; childrenAges: number[] }>;
    hotels: CertificationHotelResult[];
    totalOptions: number;
    /** False when polling stopped before WBE reported completion. */
    finished: boolean;
}

/** Read a field that WBE may return in PascalCase or camelCase. */
function field<T>(obj: any, ...keys: string[]): T | undefined {
    for (const k of keys) {
        if (obj != null && obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
    }
    return undefined;
}

/**
 * Translate the requested composition into WBE's Rooms array.
 *
 * RoomID is 1-based and must stay stable: OptionDetailsV2 and BookV2 both
 * address rooms by this index, so the order established here is the order
 * passengers must later be supplied in.
 */
export function buildCertificationRooms(
    rooms: CertificationRoomInput[],
): Array<{ RoomID: number; AdultsNo: string; ChildrenNo: string; ChildrenAges: number[] }> {
    return rooms.map((room, i) => {
        const childrenAges = room.childrenAges ?? [];
        return {
            RoomID: i + 1,
            AdultsNo: String(room.adults),
            ChildrenNo: String(childrenAges.length),
            ChildrenAges: childrenAges,
        };
    });
}

/**
 * Validate a composition before any WBE call.
 *
 * Deliberately strict: a malformed search silently yields options that cannot
 * be booked, and during certification that burns a scenario. Returns all
 * problems at once rather than failing on the first.
 */
export function validateRoomComposition(rooms: CertificationRoomInput[]): string[] {
    const errors: string[] = [];

    if (!Array.isArray(rooms) || rooms.length === 0) {
        return ['At least one room is required'];
    }
    if (rooms.length > MAX_ROOMS_PER_SEARCH) {
        errors.push(`WBE allows a maximum of ${MAX_ROOMS_PER_SEARCH} rooms per search; got ${rooms.length}`);
    }

    rooms.forEach((room, i) => {
        const label = `Room ${i + 1}`;

        if (!Number.isInteger(room.adults) || room.adults < 1) {
            errors.push(`${label}: adults must be a positive integer`);
        }

        const ages = room.childrenAges;
        if (ages === undefined) return;

        if (!Array.isArray(ages)) {
            errors.push(`${label}: childrenAges must be an array`);
            return;
        }
        ages.forEach((age, j) => {
            // 0 is legitimate — WBE's scenario 5 books a 1-year-old, and
            // infants under one are expressed as age 0.
            if (!Number.isInteger(age) || age < 0 || age > 17) {
                errors.push(`${label}, child ${j + 1}: age must be an integer between 0 and 17; got ${age}`);
            }
        });
    });

    return errors;
}

/** Add nights to an ISO date, returning ISO. Used for the check-out date. */
function addNights(checkInDate: string, nights: number): string {
    const d = new Date(`${checkInDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + nights);
    return d.toISOString().slice(0, 10);
}

export class CertificationSearchService {
    /**
     * Run a raw availability search and return every option WBE offered.
     *
     * No supplier filtering, cancellation filtering, price-band selection or
     * markup is applied — certification has to observe the unmodified contract.
     */
    async search(params: CertificationSearchParams): Promise<CertificationSearchResult> {
        const errors = validateRoomComposition(params.rooms);
        if (errors.length > 0) {
            throw new Error(`Invalid room composition: ${errors.join('; ')}`);
        }
        if (!Number.isInteger(params.nights) || params.nights < 1) {
            throw new Error('nights must be a positive integer');
        }

        const hotelCodes = await this.resolveHotelCodes(params);
        if (hotelCodes.length === 0) {
            throw new Error('No hotel codes to search — pass hotelCodes or a destinationId that resolves to hotels');
        }

        const wbeRooms = buildCertificationRooms(params.rooms);
        const requestBody = {
            HotelIds: hotelCodes,
            CheckInDate: params.checkInDate,
            Nights: params.nights,
            WaitSeconds: params.waitSeconds ?? DEFAULT_WAIT_SECONDS,
            CurrencyCode: params.currencyCode ?? 'EUR',
            NationalityCode: params.nationalityCode ?? 'DE',
            Rooms: wbeRooms,
        };

        logger.info({
            msg: 'Certification search dispatched',
            hotelCount: hotelCodes.length,
            checkInDate: params.checkInDate,
            nights: params.nights,
            rooms: wbeRooms,
        });

        const response = await wbeClientService.searchAndGetByHotelsV2(requestBody);

        const sessionId =
            field<string>(response, 'SessionID', 'SessionId', 'sessionId') ?? '';
        if (!sessionId) {
            // Without a SessionID nothing downstream can run: OptionDetailsV2
            // and BookV2 both require it alongside the TID.
            throw new Error('WBE search returned no SessionID — cannot proceed to option details or booking');
        }

        let hotelEntries: any[] = field<any[]>(response, 'Data', 'data', 'Hotels', 'hotels') ?? [];
        let finished = field<boolean>(response, 'Finished', 'finished') ?? true;

        if (!finished) {
            const { hotels: polled, finished: pollFinished } = await this.pollUntilFinished(sessionId);
            hotelEntries = [...hotelEntries, ...polled];
            finished = pollFinished;
        }

        const hotels = this.parseHotels(hotelEntries, params.mealType);
        const totalOptions = hotels.reduce((sum, h) => sum + h.options.length, 0);

        logger.info({
            msg: 'Certification search completed',
            sessionId,
            hotelsWithOptions: hotels.length,
            totalOptions,
            finished,
        });

        return {
            sessionId,
            checkInDate: params.checkInDate,
            checkOutDate: addNights(params.checkInDate, params.nights),
            nights: params.nights,
            roomsRequested: wbeRooms.map((r) => ({
                roomId: r.RoomID,
                adults: Number(r.AdultsNo),
                children: Number(r.ChildrenNo),
                childrenAges: r.ChildrenAges,
            })),
            hotels,
            totalOptions,
            finished,
        };
    }

    /**
     * Re-read a hotel's options via GetUpdatedOptions.
     *
     * Required whenever a search option carries UpdatedOptionsNeeded = true:
     * those prices came from cache and the supplier has newer ones. Booking
     * against the stale TID risks a price mismatch at prebook.
     */
    async getUpdatedOptions(
        sessionId: string,
        hotelCode: string,
        mealType?: string,
    ): Promise<CertificationHotelResult[]> {
        const response = await wbeClientService.getUpdatedOptionsV2({
            SessionID: sessionId,
            HotelId: hotelCode,
        });

        const hotelEntries = field<any[]>(response, 'Data', 'data', 'Hotels', 'hotels') ?? [];
        return this.parseHotels(hotelEntries, mealType);
    }

    /** Hotel codes from the caller, or resolved from a destination. */
    private async resolveHotelCodes(params: CertificationSearchParams): Promise<string[]> {
        if (params.hotelCodes?.length) {
            return params.hotelCodes.slice(0, MAX_HOTEL_IDS_PER_CALL);
        }
        if (params.destinationId === undefined) return [];

        const limit = Math.min(params.hotelLimit ?? MAX_HOTEL_IDS_PER_CALL, MAX_HOTEL_IDS_PER_CALL);
        const rows = await hotelSearchRepository.getHotelCodesByDestination(
            params.destinationId,
            // An empty star list means "any rating" to the repository.
            params.starRatings ?? [],
            limit,
            0,
        );
        return rows.map((r) => r.hotelCode).filter(Boolean).slice(0, MAX_HOTEL_IDS_PER_CALL);
    }

    /** Accumulate results until WBE reports Finished or the budget expires. */
    private async pollUntilFinished(
        sessionId: string,
    ): Promise<{ hotels: any[]; finished: boolean }> {
        const start = Date.now();
        const accumulated: any[] = [];

        while (Date.now() - start < MAX_POLL_WAIT_MS) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            try {
                const update = await wbeClientService.getUpdatedOptionsV2({ SessionID: sessionId });
                const hotels = field<any[]>(update, 'Data', 'data', 'Hotels', 'hotels') ?? [];
                accumulated.push(...hotels);
                if (field<boolean>(update, 'Finished', 'finished') ?? false) {
                    return { hotels: accumulated, finished: true };
                }
            } catch (err: any) {
                // Give back whatever arrived rather than failing the search —
                // partial results are still usable for certification.
                logger.warn({ msg: 'Certification search poll failed', sessionId, error: err.message });
                return { hotels: accumulated, finished: false };
            }
        }
        return { hotels: accumulated, finished: false };
    }

    /**
     * Normalise WBE's hotel/option payload.
     *
     * Options are merged by hotel code because polling returns the same hotel
     * across batches, and de-duplicated by TID so a repeated option is not
     * counted twice. Hotels with no surviving options are dropped.
     */
    private parseHotels(hotelEntries: any[], mealType?: string): CertificationHotelResult[] {
        const byHotel = new Map<string, CertificationHotelResult>();
        const seenTids = new Map<string, Set<string>>();

        for (const entry of hotelEntries ?? []) {
            const hotelCode = field<string>(entry, 'HotelCode', 'hotelCode');
            if (!hotelCode) continue;

            if (!byHotel.has(hotelCode)) {
                byHotel.set(hotelCode, {
                    hotelCode,
                    hotelName: field<string>(entry, 'HotelName', 'hotelName'),
                    destinationId: field<number>(entry, 'DestinationId', 'destinationId'),
                    destinationName: field<string>(entry, 'DestinationName', 'destinationName'),
                    options: [],
                });
                seenTids.set(hotelCode, new Set());
            }

            const target = byHotel.get(hotelCode)!;
            const tids = seenTids.get(hotelCode)!;

            for (const opt of field<any[]>(entry, 'Options', 'options') ?? []) {
                const tid = field<string>(opt, 'TID', 'Tid', 'tid');
                const totalPrice = field<number>(opt, 'TotalPrice', 'totalPrice');
                if (!tid || totalPrice === undefined) continue;
                if (tids.has(tid)) continue;

                const optMealType = field<string>(opt, 'MealType', 'mealType');
                if (mealType && optMealType && optMealType.toUpperCase() !== mealType.toUpperCase()) {
                    continue;
                }

                tids.add(tid);
                target.options.push({
                    tid,
                    totalPrice: Number(totalPrice),
                    currency: field<string>(opt, 'Currency', 'currency') ?? 'EUR',
                    mealType: optMealType,
                    mealName: field<string>(opt, 'MealName', 'mealName'),
                    onRequest: field<boolean>(opt, 'OnRequest', 'onRequest') ?? false,
                    updatedOptionsNeeded:
                        field<boolean>(opt, 'UpdatedOptionsNeeded', 'updatedOptionsNeeded') ?? false,
                    supplierCode: field<string>(opt, 'SupplierCode', 'supplierCode'),
                    rooms: (field<any[]>(opt, 'Rooms', 'rooms') ?? []).map((r: any) => ({
                        roomId: field<number>(r, 'RoomId', 'RoomID', 'roomId') ?? 0,
                        description: field<string>(r, 'Description', 'description'),
                    })),
                });
            }
        }

        return Array.from(byHotel.values())
            .filter((h) => h.options.length > 0)
            .map((h) => ({
                ...h,
                options: h.options.sort((a, b) => a.totalPrice - b.totalPrice),
            }));
    }
}

export default new CertificationSearchService();

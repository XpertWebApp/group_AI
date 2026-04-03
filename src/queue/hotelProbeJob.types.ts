/** One room entry in the expanded group room list. */
export interface ExpandedRoom {
    adults: number;
    children: number;
    childrenAges: number[];
}

/** Per-room-type probe target — how many of each type to probe (requested × PROBE_MULTIPLIER). */
export interface RoomTypeProbeTarget {
    roomType: string;       // 'single' | 'double' | 'twin' | 'triple' | 'quadruple' | 'suites' | 'standardDoubleBeds' | 'twinBeds'
    requested: number;      // original count from booking request
    probeLimit: number;     // requested * PROBE_MULTIPLIER
    adults: number;         // from ROOM_TYPE_ADULTS config
    children: number;
    childrenAges: number[];
}

/** Per-room-type progress tracked during probing. */
export interface RoomTypeProbeProgress {
    roomType: string;
    requested: number;
    probeLimit: number;
    roomsFound: number;
}

/** Payload published to the RabbitMQ hotel_probe_jobs queue. */
export interface HotelProbeJobPayload {
    jobId: string;
    searchRequestId: string;
    hotelCode: string;
    checkinDate: string;
    nights: number;
    requestedRooms: number;
    probeLimit: number;
    currencyCode: string;
    nationalityCode: string;
    waitSeconds: number;
    mealType?: string;
    markupPercent: number;
    /** Expanded room list derived from the booking request rooms JSON. */
    expandedRooms: ExpandedRoom[];
    dominantRoomType: string | null;
    /** Per-room-type probe targets. If absent, falls back to aggregate probing. */
    roomTypeTargets?: RoomTypeProbeTarget[];
}

/** Status emitted via SSE for each hotel probe job. */
export type HotelProbeStatus =
    | 'UNKNOWN'
    | 'QUEUED'
    | 'PROBING'
    | 'CONFIRMED'
    | 'LIMITED'
    | 'INSUFFICIENT'
    | 'FAILED';

export interface HotelProbeProgressEvent {
    hotelCode: string;
    status: HotelProbeStatus;
    roomsFound: number;
    lastProbeRange: string;
    percentComplete: number;
    message: string;
    roomTypeProgress?: RoomTypeProbeProgress[];
}

export interface HotelProbeCompletedEvent {
    hotelCode: string;
    status: HotelProbeStatus;
    roomsFound: number;
    capacityVerificationRequired: boolean;
    result?: any; // HotelResult or null if skipped
    reason?: string;
    roomTypeProgress?: RoomTypeProbeProgress[];
}

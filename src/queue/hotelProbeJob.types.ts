/** One room entry in the expanded group room list. */
export interface ExpandedRoom {
    adults: number;
    children: number;
    childrenAges: number[];
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
}

export interface HotelProbeCompletedEvent {
    hotelCode: string;
    status: HotelProbeStatus;
    roomsFound: number;
    capacityVerificationRequired: boolean;
    result?: any; // HotelResult or null if skipped
    reason?: string;
}

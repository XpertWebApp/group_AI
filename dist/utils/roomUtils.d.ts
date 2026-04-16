/**
 * Check whether the rooms object uses the new format (standardDoubleBeds / twinBeds breakdown).
 * When the new fields are present and > 0, `double` and `twin` should be ignored to avoid double-counting.
 */
export declare function hasNewDoubleBreakdown(rooms: any): boolean;
/**
 * Return a copy of the rooms object with double/twin zeroed out when new breakdown fields are present.
 * This prevents double-counting when iterating Object.entries(rooms).
 */
export declare function normalizeRoomCounts(rooms: any): Record<string, any>;
/** Count the total rooms requested across all room types. */
export declare function countTotalRooms(rooms: any): number;

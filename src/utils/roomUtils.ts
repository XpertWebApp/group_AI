/**
 * Check whether the rooms object uses the new format (standardDoubleBeds / twinBeds breakdown).
 * When the new fields are present and > 0, `double` and `twin` should be ignored to avoid double-counting.
 */
export function hasNewDoubleBreakdown(rooms: any): boolean {
    return ((rooms.standardDoubleBeds ?? 0) > 0 || (rooms.twinBeds ?? 0) > 0);
}

/**
 * Return a copy of the rooms object with double/twin zeroed out when new breakdown fields are present.
 * This prevents double-counting when iterating Object.entries(rooms).
 */
export function normalizeRoomCounts(rooms: any): Record<string, any> {
    if (!rooms || typeof rooms !== 'object') return {};
    const copy = { ...rooms };
    if (hasNewDoubleBreakdown(copy)) {
        copy.double = 0;
        copy.twin = 0;
    }
    return copy;
}

/** Count the total rooms requested across all room types. */
export function countTotalRooms(rooms: any): number {
    if (!rooms || typeof rooms !== 'object') return 0;

    const useNewBreakdown = hasNewDoubleBreakdown(rooms);

    // Double-category rooms: use new breakdown fields OR legacy double+twin, never both
    const doubleCategoryRooms = useNewBreakdown
        ? (rooms.standardDoubleBeds ?? 0) + (rooms.twinBeds ?? 0)
        : (rooms.double ?? 0) + (rooms.twin ?? 0);

    return (
        (rooms.single ?? 0) +
        doubleCategoryRooms +
        (rooms.triple ?? 0) +
        (rooms.quadruple ?? 0) +
        (rooms.suites ?? 0)
    );
}

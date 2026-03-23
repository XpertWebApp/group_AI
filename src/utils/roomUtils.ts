/** Count the total rooms requested across all room types. */
export function countTotalRooms(rooms: any): number {
    if (!rooms || typeof rooms !== 'object') return 0;
    return (
        (rooms.single ?? 0) +
        (rooms.double ?? 0) +
        (rooms.twin ?? 0) +
        (rooms.triple ?? 0) +
        (rooms.quadruple ?? 0) +
        (rooms.suites ?? 0)
    );
}

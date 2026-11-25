/**
 * Name patterns that flag a hotel as "youth-friendly" — used as a soft
 * ranking signal for Youth Group and School Group bookings.
 *
 * This is a SIGNAL, not a FILTER. The accumulation gate keeps every
 * hotel in the proposal; youth-friendly ones just sort to the top.
 * A regular hotel can still legitimately serve a school group (the
 * "Athens hotel" precedent Oliver cited).
 *
 * Patterns are matched as case-insensitive substrings against the hotel
 * name. The list is multilingual because the WBE catalog covers six
 * language families and DACH/EU school-trip inventory in particular.
 *
 * Explicitly excluded — would poison results (verified against the
 * 485,853-row master.hotels table):
 *   - "inn"      → 44,932 chain-hotel false positives (Premier Inn,
 *                  Hampton Inn, Best Western, Holiday Inn).
 *   - "lodge"    → 9,324 matches mixing budget youth lodges with
 *                  luxury safari / ski lodges; can't separate cleanly.
 *   - "camp"     → real campsites, not group lodging.
 *   - "pub"      → substring noise: "Republic", "Republica", "Public".
 *   - "roadhouse / hospice / flophouse" → ≤15 matches each, all noise.
 */
export const YOUTH_FRIENDLY_NAME_PATTERNS: readonly string[] = [
    // English
    'hostel', 'hostal', 'backpacker', 'dorm', 'youth',
    'guesthouse', 'guest house',
    'bunkhouse', 'boardinghouse', 'boarding house', 'lodging house',
    'homestay',
    // German
    'jugendherberge', 'herberge', 'gasthaus', 'gasthof', 'pension',
    // French
    'auberge',
    // Italian
    'ostello', 'locanda',
    // Spanish / Portuguese
    'albergue', 'pousada', 'posada',
    // Hospitality / B&B
    'b&b', 'bed and breakfast', 'bed & breakfast',
];

/**
 * True when the hotel name contains any youth-friendly pattern.
 * Returns false for empty / null / undefined names.
 */
export function isYouthFriendlyName(name: string | null | undefined): boolean {
    if (!name) return false;
    const lower = name.toLowerCase();
    return YOUTH_FRIENDLY_NAME_PATTERNS.some((p) => lower.includes(p));
}

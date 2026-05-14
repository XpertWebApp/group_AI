/**
 * GIATA imageType codes ranked by Oliver's approved priority for the hotel
 * card's primary image:
 *   exterior → room → lobby → restaurant → pool → fitness/spa → others.
 *
 * GIATA MHG uses SHORT LOWERCASE codes (verified against live data):
 *   a  = facade / apartment exterior
 *   r  = room
 *   l  = lobby
 *   p  = pool
 *   f  = food / restaurant
 *   w  = wellness
 *   s  = sport
 *   t  = terrace / view
 *   ba = bathroom
 *   k  = kitchen
 *
 * Any type not listed here falls through to priority 0 and is only picked
 * if nothing better is available.
 */
export const GIATA_IMAGE_TYPE_PRIORITY: Record<string, number> = {
    a:  100, // Facade / exterior
    r:  80,  // Room
    l:  60,  // Lobby
    p:  40,  // Pool
    f:  30,  // Restaurant / food
    w:  25,  // Wellness
    t:  20,  // Terrace / view
    s:  15,  // Sport
    ba: 5,   // Bathroom
    k:  5,   // Kitchen
};

/**
 * Pick the best GIATA image from a list, preferring higher `imageType` priority
 * first, then lower `displayOrder` within the same type. Returns null for
 * empty/missing input.
 */
export function pickBestGiataImage<T extends { imageType: string | null; displayOrder: number }>(
    images: T[],
): T | null {
    if (!images || images.length === 0) return null;
    return sortGiataImagesByPriority(images)[0] ?? null;
}

/**
 * Sort every GIATA image for a hotel in the same priority order used by
 * `pickBestGiataImage`. The FE uses this as a fallback chain — when the
 * top-priority URL fails to load (CDN miss, broken row), it tries the
 * next one, and so on. Returns a new array; does not mutate the input.
 */
export function sortGiataImagesByPriority<T extends { imageType: string | null; displayOrder: number }>(
    images: T[],
): T[] {
    return [...images].sort((a, b) => {
        const pa = GIATA_IMAGE_TYPE_PRIORITY[(a.imageType ?? '').toLowerCase()] ?? 0;
        const pb = GIATA_IMAGE_TYPE_PRIORITY[(b.imageType ?? '').toLowerCase()] ?? 0;
        if (pa !== pb) return pb - pa;          // higher priority first
        return a.displayOrder - b.displayOrder; // lower displayOrder first
    });
}

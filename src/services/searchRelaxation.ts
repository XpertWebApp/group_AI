/**
 * Search Relaxation Helpers — "never say no" pipeline.
 *
 * Oliver's approved order (NeverSayNo.txt):
 *   1. Star rating: ±1 → ±2 → ignore
 *   2. Meal type: drop BB/RO filter
 *   3. Hotel location: drop central/outside filter
 *   4. Facilities: drop facility filters last
 *
 * Then if still zero, widen destination: parent → country → nearby (lat/lng).
 * Travel dates are never altered — Oliver explicitly rejected flexible dates.
 */

export type RelaxationLevel =
    | 'exact'
    | 'star_pm1'           // ±1 stars (current default behaviour)
    | 'star_pm2'           // ±2 stars
    | 'star_any'           // ignore star rating
    | 'meal_dropped'       // also drop meal type
    | 'location_dropped'   // also drop hotel location
    | 'facilities_dropped';// also drop facilities

export interface RelaxationConfig {
    level: RelaxationLevel;
    starWindow: 'exact' | 'pm1' | 'pm2' | 'any';
    keepMealType: boolean;
    keepHotelLocation: boolean;
    keepFacilities: boolean;
}

export const RELAXATION_LADDER: ReadonlyArray<RelaxationConfig> = [
    { level: 'exact',              starWindow: 'exact', keepMealType: true,  keepHotelLocation: true,  keepFacilities: true  },
    { level: 'star_pm1',           starWindow: 'pm1',   keepMealType: true,  keepHotelLocation: true,  keepFacilities: true  },
    { level: 'star_pm2',           starWindow: 'pm2',   keepMealType: true,  keepHotelLocation: true,  keepFacilities: true  },
    { level: 'star_any',           starWindow: 'any',   keepMealType: true,  keepHotelLocation: true,  keepFacilities: true  },
    { level: 'meal_dropped',       starWindow: 'any',   keepMealType: false, keepHotelLocation: true,  keepFacilities: true  },
    { level: 'location_dropped',   starWindow: 'any',   keepMealType: false, keepHotelLocation: false, keepFacilities: true  },
    { level: 'facilities_dropped', starWindow: 'any',   keepMealType: false, keepHotelLocation: false, keepFacilities: false },
];

/**
 * Build the star-rating list to pass to getHotelCodesByDestination based on
 * the relaxation `starWindow`. Empty array means "no star filter".
 *
 * Examples (requested = 4):
 *   exact → [4]
 *   pm1   → [3, 3.5, 4, 4.5, 5]
 *   pm2   → [2, 2.5, 3, 3.5, 4, 4.5, 5]
 *   any   → []
 */
export function buildStarList(
    requested: number | null,
    window: 'exact' | 'pm1' | 'pm2' | 'any',
): number[] {
    if (window === 'any' || requested == null) return [];
    if (window === 'exact') return [requested];
    const half = window === 'pm1' ? 1 : 2;
    const out: number[] = [];
    const min = Math.max(1, requested - half);
    const max = Math.min(5, requested + half);
    for (let s = min; s <= max + 0.01; s += 0.5) {
        out.push(Math.round(s * 2) / 2);
    }
    return [...new Set(out)];
}

/**
 * Human-readable banner string shown to the user when a relaxation level
 * higher than the default (`star_pm1`) is applied. Returns null when no
 * banner should be shown (i.e. the search ran with the user's intended
 * criteria, only the existing ±1 stars convenience widening).
 */
export function describeRelaxation(level: RelaxationLevel): string | null {
    switch (level) {
        case 'exact':
        case 'star_pm1':
            return null;
        case 'star_pm2':
            return "We couldn't find exact matches — widened the star rating to find the closest available options.";
        case 'star_any':
            return "We couldn't find exact matches — showing hotels of all star ratings.";
        case 'meal_dropped':
            return "We couldn't find exact matches — showing hotels regardless of meal plan.";
        case 'location_dropped':
            return "We couldn't find exact matches — showing hotels in any part of the destination.";
        case 'facilities_dropped':
            return "We couldn't find exact matches — showing hotels without the requested amenities.";
    }
}

/**
 * Builds the banner message shown when the search had to fall back to a
 * wider destination (e.g. parent / country / nearby).
 */
export function describeDestinationFallback(
    candidateCount: number,
    originalName: string,
    usedName: string,
): string {
    return `${candidateCount} hotel(s) found in ${usedName} — exact area was ${originalName}. Showing the closest available options.`;
}

/**
 * Per-hotel badge label shown alongside an alternative result so the user
 * understands WHY a particular hotel is in the "Similar alternatives" section.
 *
 * Uses the same relaxation level vocabulary as describeRelaxation, but
 * phrased as a short tag rather than a full sentence. When the alternative
 * comes from a different destination (parent / country / nearby), that takes
 * precedence over the filter relaxation reason.
 */
export function describeAlternativeReason(
    level: RelaxationLevel,
    fromDifferentDestination: boolean,
): string {
    if (fromDifferentDestination) return 'From a nearby destination';
    switch (level) {
        case 'star_pm1':
        case 'star_pm2':
            return 'Wider star rating';
        case 'star_any':
            return 'Different star rating';
        case 'meal_dropped':
            return 'Without breakfast';
        case 'location_dropped':
            return 'Different area';
        case 'facilities_dropped':
            return 'Without all amenities';
        case 'exact':
        default:
            return 'Alternative match';
    }
}

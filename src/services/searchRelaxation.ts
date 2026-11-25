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
 * Accepts an ARRAY of requested star categories (one entry per ticked box
 * on the create-request form). The widening logic is applied to each entry
 * independently, then the results are unioned + deduped.
 *
 * Examples (window = pm1):
 *   requested = [4]      → [3, 3.5, 4, 4.5, 5]
 *   requested = [3, 4]   → [2, 2.5, 3, 3.5, 4, 4.5, 5]    (3±1 ∪ 4±1)
 *   requested = [3, 5]   → [2, 2.5, 3, 3.5, 4, 4.5, 5]    (3±1 ∪ 5±1)
 *   requested = [3, 4]   with window = exact → [3, 4]
 *   requested = []       → []     ("any rating" — empty filter)
 *
 * Back-compat: pass a single number wrapped in `[n]`, or call with `null`
 * (legacy "no rating" sentinel — returns []).
 */
export function buildStarList(
    requested: number[] | number | null,
    window: 'exact' | 'pm1' | 'pm2' | 'any',
): number[] {
    if (window === 'any' || requested == null) return [];
    const stars = Array.isArray(requested) ? requested : [requested];
    if (stars.length === 0) return [];
    if (window === 'exact') return [...new Set(stars)].sort((a, b) => a - b);

    const half = window === 'pm1' ? 1 : 2;
    const out = new Set<number>();
    for (const star of stars) {
        const min = Math.max(1, star - half);
        const max = Math.min(5, star + half);
        for (let s = min; s <= max + 0.01; s += 0.5) {
            out.add(Math.round(s * 2) / 2);
        }
    }
    return [...out].sort((a, b) => a - b);
}

/**
 * Build the "expanding ring" star ladder for a request.
 *
 * Each tier is the FULL cumulative star list to query at that step
 * (suitable to pass directly to `getHotelCodesByDestination`). The
 * inner pagination loop in the watcher uses this so that, after a
 * tier's pagination exhausts, the next tier adds the NEXT-CLOSEST
 * star(s) to the requested centres.
 *
 * Priority within ±1 of each requested centre (Oliver's brief):
 *   tier 0: the requested star(s) themselves           (distance 0)
 *   tier 1: +0.5 from any centre                       (closest UP)
 *   tier 2: +1.0 from any centre                       (one full step UP)
 *   tier 3: -0.5 from any centre                       (closest DOWN)
 *   tier 4: -1.0 from any centre                       (one full step DOWN)
 *
 * Up-first bias is intentional — Oliver prefers showing "a 4-star at
 * 3-star price" over a 2-star to a 3-star requester.
 *
 * Multi-select: each requested star is its own centre. Their rings
 * are merged tier-by-tier by best priority (a star that's +0.5 from
 * centre A AND -0.5 from centre B lands in tier 1, not tier 3).
 *
 * Stars are clamped to [1, 5]. Empty `requested` returns a single
 * empty-array tier = "no star filter".
 *
 * Examples:
 *   [3]    → [[3], [3, 3.5], [3, 3.5, 4], [2.5, 3, 3.5, 4], [2, 2.5, 3, 3.5, 4]]
 *   [3, 4] → [[3, 4], [3, 3.5, 4, 4.5], [3, 3.5, 4, 4.5, 5],
 *             [2.5, 3, 3.5, 4, 4.5, 5], [2, 2.5, 3, 3.5, 4, 4.5, 5]]
 *   []     → [[]]
 */
export function buildExpandingRingLadder(requested: number[]): number[][] {
    if (!requested || requested.length === 0) return [[]];

    const centres = [...new Set(requested)].filter((n) => Number.isFinite(n));
    if (centres.length === 0) return [[]];

    // Offsets in priority order — up first, then down. ±1 cap.
    const offsets = [0, 0.5, 1, -0.5, -1] as const;

    // For each star within ±1 of any centre, record the BEST (lowest-index)
    // tier it qualifies for across all centres. A star qualifies for tier
    // `i` from centre `c` iff `c + offsets[i] === s` (within 0.01 tolerance).
    const bestTier = new Map<number, number>();
    for (let tier = 0; tier < offsets.length; tier++) {
        for (const c of centres) {
            const raw = c + offsets[tier];
            const s = Math.round(raw * 2) / 2;
            if (s < 1 || s > 5) continue;
            if (!bestTier.has(s) || tier < bestTier.get(s)!) {
                bestTier.set(s, tier);
            }
        }
    }

    // Build cumulative tiers: tier N contains all stars whose bestTier <= N.
    const tiers: number[][] = [];
    for (let i = 0; i < offsets.length; i++) {
        const stars = [...bestTier.entries()]
            .filter(([_, t]) => t <= i)
            .map(([s]) => s)
            .sort((a, b) => a - b);
        tiers.push(stars);
    }

    // De-duplicate adjacent identical tiers — if a centre is at the edge
    // of the clamp (e.g. 5-star request → +1.0 lands at 6, clamped out),
    // some tiers may be identical to their predecessor. No point in
    // running the inner pagination loop a second time with the same
    // filter — drop the duplicates.
    const dedup: number[][] = [];
    for (const t of tiers) {
        const last = dedup[dedup.length - 1];
        if (!last || JSON.stringify(last) !== JSON.stringify(t)) dedup.push(t);
    }
    return dedup;
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

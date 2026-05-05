/**
 * Floor a star rating to a whole number (e.g. 3.5 → 3, 4.5 → 4) for display
 * to the user. WBE/master data sometimes carries .5 ratings, but the UI shows
 * whole-star icons only — Oliver wants 3.5★ rendered as 3★.
 *
 * Returns null/undefined unchanged so callers can chain without null checks.
 */
export function floorStarRating(value: number | null | undefined): number | null {
    if (value == null) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.floor(n);
}

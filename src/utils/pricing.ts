/**
 * Pricing normalisation utilities for WBE API responses.
 *
 * Per WBE's OptionDetailsV2 / SearchAndGetByHotelsV2 technical docs:
 *   - `TotalPrice` on an option = the complete booking total for that option
 *     (all rooms × all nights + supplements − special offers)
 *   - `Rooms[]` on an option = the actual rooms included in that option
 *
 * PREVIOUSLY: the codebase divided by a hardcoded batchSize (3), which gave
 * incorrect per-room-per-night values when WBE returned options with a
 * different room count (e.g., partial availability). Fix: divide by the
 * actual `Rooms.length` the option contains.
 */

import logger from './logger';

/**
 * Suspicious price thresholds. Real hotel rates almost never fall outside this band
 * for 3★+ properties. If a computed price is outside, log a warning so we can
 * catch mapping bugs early.
 */
const MIN_EXPECTED_PER_NIGHT = 20;
const MAX_EXPECTED_PER_NIGHT = 5000;

/**
 * Compute per-room-per-night price from a WBE option.
 *
 * @param rawTotalPrice - the `TotalPrice` field from the WBE option (booking total)
 * @param roomsInOption - the actual number of rooms in the option (`Rooms.length`)
 * @param nights - the number of nights in the stay
 * @param ctx - optional context for diagnostic logging
 * @returns per-room-per-night price, or 0 if inputs are invalid
 */
export function normalisePricePerRoomPerNight(
    rawTotalPrice: number,
    roomsInOption: number,
    nights: number,
    ctx?: { hotelCode?: string; tid?: string; supplierCode?: string },
): number {
    if (!rawTotalPrice || !roomsInOption || !nights) return 0;

    const perRoomPerNight = rawTotalPrice / (roomsInOption * nights);

    // Sanity check — flag obviously wrong prices so they stand out in logs
    if (perRoomPerNight < MIN_EXPECTED_PER_NIGHT || perRoomPerNight > MAX_EXPECTED_PER_NIGHT) {
        logger.warn(
            {
                rawTotalPrice,
                roomsInOption,
                nights,
                perRoomPerNight,
                ...ctx,
            },
            `Suspicious per-room-per-night price: ${perRoomPerNight.toFixed(2)} (expected ${MIN_EXPECTED_PER_NIGHT}–${MAX_EXPECTED_PER_NIGHT} range)`,
        );
    }

    return perRoomPerNight;
}

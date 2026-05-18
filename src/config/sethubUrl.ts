/**
 * SETTHub hotel-detail URL builder.
 *
 * The live SETTHub site exposes rich hotel pages (images, description, map,
 * amenities) at:
 *   https://booking.s-e-t-t.com/Availability/Hotel/Details/<base64>
 * where <base64> = base64(JSON.stringify({
 *     AccountId: 180,
 *     Language: 'en' | 'de',
 *     HotelId: <masterHotelId>,
 * }))
 *
 * Oliver's direction: keep GroupHub simple — instead of building our own
 * detail page, surface the SETTHub URL on each search-result card so the
 * frontend can wrap the hotel name in a link that opens the existing
 * SETTHub page in a new tab.
 */

const SETTHUB_ACCOUNT_ID = 180;
const SETTHUB_BASE = 'https://booking.s-e-t-t.com/Availability/Hotel/Details/';

/**
 * Build the SETTHub hotel-detail URL for a given masterHotelId.
 * Returns null when masterHotelId is missing (e.g. hotel not yet synced), so
 * the frontend can render the hotel name as plain text instead of a broken link.
 *
 * @param masterHotelId  The integer `master_hotel_id` stored on `master.hotels`.
 * @param language       'en' (default) or 'de'. Propagate the user's locale here
 *                       later — hardcoded for now per Oliver's minimal ask.
 */
export function buildSethubDetailsUrl(
    masterHotelId: number | null | undefined,
    language: 'en' | 'de' = 'en',
): string | null {
    if (!masterHotelId) return null;
    const payload = JSON.stringify({
        AccountId: SETTHUB_ACCOUNT_ID,
        Language: language,
        HotelId: masterHotelId,
    });
    const b64 = Buffer.from(payload, 'utf8').toString('base64');
    return `${SETTHUB_BASE}${b64}`;
}

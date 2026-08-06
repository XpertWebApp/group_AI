/**
 * Settings for turning an accepted proposal into real reservations.
 *
 * These are the decisions that cost money when they are wrong, so they live
 * here rather than being scattered through the booking service: an operator
 * changing how much price drift is tolerable should not have to read the
 * booking flow to find the number.
 */

/**
 * How much the supplier price may exceed the quoted price before a booking
 * stops and asks for a human.
 *
 * Supplier rates are held for hours, not days. A customer who accepts a
 * proposal three days later will often be booking against a different price,
 * and someone has to decide whether SETT absorbs that difference or goes back
 * to the customer.
 *
 * The value is a percentage of the quoted total. Within it, the booking
 * proceeds and the difference is recorded on the group for reporting. Beyond
 * it, the group stops in `pending` with the drift recorded and no reservation
 * made.
 *
 * 5% is a placeholder pending the client's own figure — the request is with
 * them. Changing it here is the only change needed; nothing else reads a
 * hardcoded threshold.
 */
export const PRICE_DRIFT_TOLERANCE_PERCENT = Number(
    process.env['GROUP_BOOKING_PRICE_TOLERANCE_PERCENT'] ?? 5,
);

/**
 * A price that moved *down* is never a reason to stop.
 *
 * Stated explicitly because the tolerance above is naturally read as a band in
 * both directions, and pausing a booking because the customer is about to pay
 * less would be absurd.
 */
export const ALLOW_PRICE_DECREASE = true;

/**
 * Seconds a freshly returned search result is trusted before booking.
 *
 * The re-search runs immediately before the first BookV2 call, so this is a
 * guard against a slow run rather than a real expiry: if a group takes longer
 * than this to work through its slices, the later slices are booking against
 * a session WBE may already have dropped, and it is better to fail loudly
 * than to send a stale TID.
 */
export const SEARCH_RESULT_MAX_AGE_SECONDS = 600;

/**
 * Whether a group that cannot be filled completely keeps the rooms it did get.
 *
 * Confirmed by the client: keep them. Cancelling successful reservations means
 * losing inventory that may not be available again, and leaves the customer
 * with nothing rather than most of what they asked for. The shortfall is
 * flagged in SETT Hub for a staff member to source by hand.
 *
 * Set false only if that decision is reversed — the booking service reads this
 * rather than assuming either behaviour.
 */
export const KEEP_PARTIAL_BOOKINGS = true;

/**
 * Maximum slices one group may be split into.
 *
 * A large group across low-cap suppliers could otherwise produce a dozen
 * reservations, each its own WBE call and its own thing to cancel by hand if
 * something goes wrong. Beyond this the group is refused rather than partially
 * attempted, so the operator can pick a different hotel instead of being left
 * with a scattered booking.
 */
export const MAX_SLICES_PER_GROUP = 6;

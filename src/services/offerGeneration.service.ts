/**
 * Offer Generation Service
 *
 * Runs the full AI offer pipeline in the background after a webhook booking request is received:
 *   Step 1: Hotel search (WBE) — same as manual flow
 *   Step 2: Filter & select top 3-5 hotels (include status, mid-range price)
 *   Step 3: Fetch option details for each selected hotel
 *   Step 4: Create a proposal with those hotels
 *   Step 5: Update booking request status → ai_generated
 *   Step 6: Notify staff (email + in-app)
 */

import hotelSearchService from './hotelSearch.service';
import notificationService from './notification.service';
import requestRepository from '../repositories/request.repository';
import proposalRepository from '../repositories/proposal.repository';
import logger from '../utils/logger';
import { BookingRequestStatus } from '@prisma/client';

/** Max hotels to include in the auto-generated offer. */
const MAX_AUTO_OFFER_HOTELS = 5;

/** Default markup for auto-generated offers (%). */
const DEFAULT_MARKUP_PCT = 18;

export class OfferGenerationService {
    /**
     * Trigger the full offer generation pipeline asynchronously (fire-and-forget).
     * Returns immediately — caller gets 200 without waiting for the pipeline.
     */
    triggerAsync(requestId: string) {
        setImmediate(() => {
            this.run(requestId).catch((err) => {
                logger.error({ err, requestId }, 'Unhandled error in offer generation pipeline');
            });
        });
    }

    /**
     * Full pipeline — runs in background.
     */
    async run(requestId: string) {
        logger.info({ requestId }, 'Starting AI offer generation');

        const request = await requestRepository.findById(requestId);
        if (!request) {
            logger.error({ requestId }, 'Booking request not found for offer generation');
            return;
        }

        const refNum = (request as any).referenceNumber as number;
        const contactName = (request as any).contactName ?? (request as any).firstName ?? 'Guest';
        const destinationName = (request as any).destinationName ?? 'Unknown destination';

        // Mark request as processing before the pipeline starts
        await requestRepository.updateStatus(requestId, BookingRequestStatus.processing);

        try {
            // ── Step 1: Hotel search ──────────────────────────────────────────
            const mealType = (request as any).breakfastPreference === 'BB' ? 'BB' : undefined;

            const searchResult = await hotelSearchService.searchForRequest(requestId, { mealType });

            const includedHotels = searchResult.results.filter((r) => r.status === 'include');
            const flaggedHotels = searchResult.results.filter((r) => r.status === 'flag');

            const candidates = includedHotels.length > 0
                ? includedHotels
                : flaggedHotels; // fall back to flagged if nothing is fully included

            if (candidates.length === 0) {
                logger.warn({ requestId }, 'No suitable hotels found for auto offer');
                await notificationService.notifyOfferGenerationFailed({
                    requestId,
                    referenceNumber: refNum,
                    reason: 'No hotels with free cancellation and sufficient capacity found for this destination and dates.',
                });
                return;
            }

            // Pick top N by price (ascending — cheapest valid options first)
            const top = candidates
                .filter((h) => h.highestMidRangePrice !== undefined)
                .sort((a, b) => (a.highestMidRangePrice ?? 0) - (b.highestMidRangePrice ?? 0))
                .slice(0, MAX_AUTO_OFFER_HOTELS);

            // ── Step 2: Option details ────────────────────────────────────────
            const optionSelections = top.flatMap((hotel) =>
                hotel.selectedOptions.slice(0, 1).map((opt) => ({
                    sessionId: hotel.sessionId,
                    tid: opt.tid,
                    hotelCode: hotel.hotelCode,
                })),
            );

            const optionDetails = optionSelections.length > 0
                ? await hotelSearchService.fetchOptionDetails(optionSelections)
                : [];

            const optionDetailMap = new Map(optionDetails.map((o) => [o.tid, o]));

            // ── Step 3: Create proposal ───────────────────────────────────────
            const proposal = await proposalRepository.createForRequest(requestId, {
                notes: `Auto-generated offer from webhook submission. ${top.length} hotel(s) found.`,
                markupSettings: { globalMarkupPercent: DEFAULT_MARKUP_PCT, source: 'auto' },
            });

            // Add each selected hotel to the proposal
            for (const hotel of top) {
                const bestOption = hotel.selectedOptions[0];
                if (!bestOption) continue;

                const optDetail = optionDetailMap.get(bestOption.tid);
                const nights = (request as any).nights as number;
                const rooms = (request as any).rooms ?? {};
                const totalRooms = Object.values(rooms as Record<string, number>).reduce(
                    (s: number, v) => s + (Number(v) || 0),
                    0,
                ) || 1;

                // Prefer daypricesTotal from OptionDetailsV2 (actual per-night pricing);
                // fall back to the mid-range estimate from the initial search.
                const buyingPricePerRoomPerNight =
                    optDetail?.parsed.daypricesTotal != null && nights > 0 && totalRooms > 0
                        ? optDetail.parsed.daypricesTotal / (totalRooms * nights)
                        : bestOption.pricePerRoomPerNight;

                const { sellPrice } = hotelSearchService.calculateSellPrice(
                    buyingPricePerRoomPerNight,
                    DEFAULT_MARKUP_PCT,
                );

                const totalPrice = sellPrice * totalRooms * nights;

                await proposalRepository.addHotelTx(proposal.id, {
                    hotelCode: hotel.hotelCode,
                    tid: bestOption.tid,
                    currency: bestOption.currency ?? 'EUR',
                    totalPrice,
                    freeCancellation: bestOption.freeCancellation,
                    cancelDeadline: optDetail?.parsed.cxlDeadline ?? null,
                    supplierCode: bestOption.supplierCode,
                    rooms: {
                        [bestOption.roomDescriptions[0] || 'standard']: {
                            net: buyingPricePerRoomPerNight,
                            sell: sellPrice,
                            qty: totalRooms,
                            nights,
                        },
                    },
                });
            }

            // ── Step 4: Update request status ─────────────────────────────────
            await requestRepository.updateStatus(requestId, BookingRequestStatus.ai_generated);

            logger.info({ requestId, proposalId: proposal.id, hotelsAdded: top.length }, 'AI offer generation complete');

            // ── Step 5: Notify staff ──────────────────────────────────────────
            await notificationService.notifyNewOfferReady({
                requestId,
                referenceNumber: refNum,
                contactName,
                destinationName,
                staffEmail: process.env.STAFF_NOTIFICATION_EMAIL,
            });
        } catch (err: any) {
            logger.error({ err, requestId }, 'AI offer generation failed');

            await notificationService.notifyOfferGenerationFailed({
                requestId,
                referenceNumber: refNum,
                reason: err?.message ?? 'Unknown error',
            });
        }
    }
}

export default new OfferGenerationService();

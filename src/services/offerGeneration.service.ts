/**
 * Offer Generation Service
 *
 * Runs the full AI offer pipeline in the background after a webhook booking request is received.
 * Uses generateAutoOffer — the full PDF accumulation loop (Steps 2.1–4.2):
 *   1. Sequential per-hotel WBE search + filter + capacity checks + A2 supplier split
 *   2. Option details fetched inline per hotel (Step 3.4)
 *   3. Unified customer price = MAX buying price across all A2 splits × markup + psychology (Step 4.1)
 *   4. Create proposal with validated hotels
 *   5. Update booking request status → ai_generated
 *   6. Notify staff (email + in-app)
 */

import hotelSearchService from './hotelSearch.service';
import notificationService from './notification.service';
import requestRepository from '../repositories/request.repository';
import proposalRepository from '../repositories/proposal.repository';
import logger from '../utils/logger';
import { BookingRequestStatus } from '@prisma/client';

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
            // ── Step 1: generateAutoOffer — full PDF accumulation loop ────────
            const mealType = (request as any).breakfastPreference === 'BB' ? 'BB' : undefined;

            const autoOffer = await hotelSearchService.generateAutoOffer(requestId, {
                mealType,
                markupPercent: DEFAULT_MARKUP_PCT,
            });

            if (!autoOffer.success || autoOffer.validatedHotels.length === 0) {
                const reason = autoOffer.escalation?.suggestion
                    ?? 'No hotels with free cancellation and sufficient capacity found.';
                logger.warn({ requestId, roomsMissing: autoOffer.escalation?.roomsMissing }, reason);
                await notificationService.notifyOfferGenerationFailed({ requestId, referenceNumber: refNum, reason });
                return;
            }

            // ── Step 2: Create proposal ───────────────────────────────────────
            const proposal = await proposalRepository.createForRequest(requestId, {
                notes: `Auto-generated offer. ${autoOffer.validatedHotels.length} hotel(s), ${autoOffer.roomsCommitted} rooms committed.`,
                markupSettings: { globalMarkupPercent: DEFAULT_MARKUP_PCT, source: 'auto' },
            });

            // ── Step 3: Add each validated hotel to the proposal ──────────────
            const nights = autoOffer.nights;
            const sellingPrice = autoOffer.sellingPricePerRoomPerNight ?? 0;

            for (const hotel of autoOffer.validatedHotels) {
                // Use cheapest A2 split entry as the representative TID + supplier
                const cheapestSplit = [...hotel.supplierSplit].sort(
                    (a, b) => a.pricePerRoomPerNight - b.pricePerRoomPerNight,
                )[0];
                if (!cheapestSplit) continue;

                const roomsQty = hotel.roomsAllocated;
                const totalPrice = sellingPrice * roomsQty * nights;

                await proposalRepository.addHotelTx(proposal.id, {
                    hotelCode: hotel.hotelCode,
                    tid: cheapestSplit.tid,
                    currency: cheapestSplit.currency ?? 'EUR',
                    totalPrice,
                    freeCancellation: true, // guaranteed by filter pipeline
                    cancelDeadline: hotel.cxlDeadline,
                    supplierCode: cheapestSplit.supplierCode,
                    rooms: {
                        standard: {
                            net: cheapestSplit.pricePerRoomPerNight,
                            sell: sellingPrice,
                            qty: roomsQty,
                            nights,
                        },
                    },
                });
            }

            // ── Step 4: Update request status ─────────────────────────────────
            await requestRepository.updateStatus(requestId, BookingRequestStatus.ai_generated);

            logger.info(
                {
                    requestId,
                    proposalId: proposal.id,
                    hotelsAdded: autoOffer.validatedHotels.length,
                    totalOfferPrice: autoOffer.totalOfferPrice,
                },
                'AI offer generation complete',
            );

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

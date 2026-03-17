/**
 * Offer Generation Service
 *
 * Triggers the queue-based hotel probe pipeline, waits for all jobs to finish,
 * then builds a proposal from the results and notifies staff.
 */

import hotelSearchService from './hotelSearch.service';
import notificationService from './notification.service';
import requestRepository from '../repositories/request.repository';
import proposalRepository from '../repositories/proposal.repository';
import hotelProbeJobRepository from '../repositories/hotelProbeJob.repository';
import logger from '../utils/logger';
import { BookingRequestStatus } from '@prisma/client';

const DEFAULT_MARKUP_PCT = 18;

/** Max time to wait for all probe jobs to complete (ms). */
const JOB_WAIT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const JOB_POLL_INTERVAL_MS = 5_000; // 5 seconds

const TERMINAL_STATUSES = new Set(['COMPLETED', 'SKIPPED_INSUFFICIENT', 'FAILED']);

async function waitForJobs(searchRequestId: string): Promise<any[]> {
    const deadline = Date.now() + JOB_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, JOB_POLL_INTERVAL_MS));
        const jobs = await hotelProbeJobRepository.findBySearchRequest(searchRequestId);
        const pending = jobs.filter((j: { status: string }) => !TERMINAL_STATUSES.has(j.status));
        if (pending.length === 0) return jobs;
    }
    // Timeout — return whatever we have
    return hotelProbeJobRepository.findBySearchRequest(searchRequestId);
}

export class OfferGenerationService {
    /**
     * Trigger the full offer generation pipeline asynchronously (fire-and-forget).
     */
    triggerAsync(requestId: string) {
        setImmediate(() => {
            this.run(requestId).catch((err) => {
                logger.error({ err, requestId }, 'Unhandled error in offer generation pipeline');
            });
        });
    }

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

        await requestRepository.updateStatus(requestId, BookingRequestStatus.processing);

        try {
            // Step 1: Queue probe jobs
            const mealType = (request as any).breakfastPreference === 'BB' ? 'BB' : undefined;
            const queueResult = await hotelSearchService.generateAutoOffer(requestId, {
                mealType,
                markupPercent: DEFAULT_MARKUP_PCT,
            });

            if (queueResult.jobsQueued === 0) {
                const reason = 'No candidate hotels found for this destination and star rating.';
                await notificationService.notifyOfferGenerationFailed({ requestId, referenceNumber: refNum, reason });
                return;
            }

            logger.info({ requestId, jobsQueued: queueResult.jobsQueued }, 'Waiting for probe jobs to complete');

            // Step 2: Wait for all jobs to reach a terminal state
            const jobs = await waitForJobs(requestId);
            const completedJobs = jobs.filter((j) => (j.status as string) === 'COMPLETED');

            if (completedJobs.length === 0) {
                const reason = 'No hotels with sufficient capacity found after probing.';
                logger.warn({ requestId }, reason);
                await notificationService.notifyOfferGenerationFailed({ requestId, referenceNumber: refNum, reason });
                return;
            }

            // Step 3: Create proposal
            const proposal = await proposalRepository.createForRequest(requestId, {
                notes: `Auto-generated offer. ${completedJobs.length} hotel(s) confirmed via capacity probing.`,
                markupSettings: { globalMarkupPercent: DEFAULT_MARKUP_PCT, source: 'auto' },
            });

            let totalOfferPrice = 0;

            // Step 4: Add each confirmed hotel to the proposal
            for (const job of completedJobs) {
                const result = job.resultJson as any;
                if (!result?.supplierSplit?.length) continue;

                const cheapestSplit = [...result.supplierSplit].sort(
                    (a: any, b: any) => a.pricePerRoomPerNight - b.pricePerRoomPerNight,
                )[0] as any;
                if (!cheapestSplit) continue;

                const sellingPrice = result.sellingPricePerRoomPerNight ?? 0;
                const roomsQty = result.roomsAllocated ?? job.requestedRooms;
                const nights = (request as any).nights ?? 1;
                const hotelTotal = sellingPrice * roomsQty * nights;
                totalOfferPrice += hotelTotal;

                await proposalRepository.addHotelTx(proposal.id, {
                    hotelCode: result.hotelCode,
                    tid: cheapestSplit.tid,
                    currency: cheapestSplit.currency ?? 'EUR',
                    totalPrice: hotelTotal,
                    freeCancellation: true,
                    cancelDeadline: null,
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

            // Step 5: Update request status
            await requestRepository.updateStatus(requestId, BookingRequestStatus.ai_generated);

            logger.info(
                { requestId, proposalId: proposal.id, hotelsAdded: completedJobs.length, totalOfferPrice },
                'AI offer generation complete',
            );

            // Step 6: Notify staff
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

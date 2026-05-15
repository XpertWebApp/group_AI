/**
 * Offer Generation Service
 *
 * Triggers the queue-based hotel probe pipeline, waits for all jobs to finish,
 * then applies Step 3.5 accumulation gate (accept/skip hotels until target met),
 * builds a proposal from the accepted hotels, and notifies staff.
 */

import hotelSearchService from './hotelSearch.service';
import notificationService from './notification.service';
import requestRepository from '../repositories/request.repository';
import proposalRepository from '../repositories/proposal.repository';
import hotelProbeJobRepository from '../repositories/hotelProbeJob.repository';
import logger from '../utils/logger';
import { countTotalRooms } from '../utils/roomUtils';
import { BookingRequestStatus } from '@prisma/client';
import { TARGET_VIABLE_HOTELS, SEARCH_BATCH_SIZE, MAX_SEARCH_BATCHES } from '../config/probeConfig';

const DEFAULT_MARKUP_PCT = 18;

/** Max time to wait for all probe jobs to complete (ms). */
const JOB_WAIT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const JOB_POLL_INTERVAL_MS = 5_000; // 5 seconds
const DEFAULT_MIN_MEANINGFUL_CONTRIBUTION = 6;

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

// ─── Step 3.5 — Hotel Accepted or Skipped? (Accumulation Gate) ───────────────

interface AccumulationResult {
    accepted: any[];
    skipped: Array<{ job: any; reason: string }>;
    roomsCommitted: number;
    roomsNeeded: number;
    targetMet: boolean;
}

/**
 * Step 3.5 — Cross-hotel accumulation gate.
 *
 * Sorts completed hotels by priority (star match → capacity status → rooms → price),
 * accepts hotels one by one, tracks rooms_committed, and stops once the target is met.
 * Remaining hotels are skipped with "target already met".
 */
function applyAccumulationGate(
    completedJobs: any[],
    roomsNeeded: number,
    requestedStarRating: number | null,
    groupType: string | null = null,
): AccumulationResult {
    const statusOrder: Record<string, number> = { CONFIRMED: 0, LIMITED: 1 };

    // For youth and school groups, hotels whose names match the youth-friendly
    // pattern list (hostels, Jugendherbergen, auberges, ostelli, B&Bs, …) get
    // promoted ahead of everything else. Non-friendly hotels still stay in the
    // result set — Oliver's "Athens hotel" precedent: a regular hotel can
    // legitimately serve a school group.
    const promoteYouthFriendly = groupType === 'youth' || groupType === 'school';

    // Sort: [youth-friendly tier when applicable] → star match → CONFIRMED
    // before LIMITED → most rooms → cheapest price
    const sorted = [...completedJobs].sort((a, b) => {
        const ra = a.resultJson as any;
        const rb = b.resultJson as any;

        // Top tier (youth/school only): youth-friendly first
        if (promoteYouthFriendly) {
            const aYF = ra.youthFriendly === true ? 0 : 1;
            const bYF = rb.youthFriendly === true ? 0 : 1;
            if (aYF !== bYF) return aYF - bYF;
        }

        // Primary: star rating match
        const aStarMatch = requestedStarRating != null && ra.starRating === requestedStarRating ? 0 : 1;
        const bStarMatch = requestedStarRating != null && rb.starRating === requestedStarRating ? 0 : 1;
        if (aStarMatch !== bStarMatch) return aStarMatch - bStarMatch;

        // Secondary: CONFIRMED before LIMITED
        const aStatus = statusOrder[ra.capacityStatus] ?? 2;
        const bStatus = statusOrder[rb.capacityStatus] ?? 2;
        if (aStatus !== bStatus) return aStatus - bStatus;

        // Tertiary: more rooms first (fills target faster)
        const aRooms = ra.roomsAllocated ?? 0;
        const bRooms = rb.roomsAllocated ?? 0;
        if (bRooms !== aRooms) return bRooms - aRooms;

        // Quaternary: cheaper price first
        return (ra.sellingPricePerRoomPerNight ?? 0) - (rb.sellingPricePerRoomPerNight ?? 0);
    });

    const accepted: any[] = [];
    const skipped: Array<{ job: any; reason: string }> = [];
    let roomsCommitted = 0;

    console.log(`[Step 3.5] Starting accumulation gate: ${sorted.length} completed hotels, roomsNeeded=${roomsNeeded}`);
    logger.info({ completedCount: sorted.length, roomsNeeded, requestedStarRating, groupType, promoteYouthFriendly }, 'Step 3.5: Starting accumulation gate');

    for (const job of sorted) {
        const result = job.resultJson as any;
        const hotelName = result?.hotelName ?? result?.hotelCode ?? 'Unknown';
        const hotelCode = result?.hotelCode ?? '';
        const allocated = result?.roomsAllocated ?? 0;

        // Early exit — target already met
        if (roomsCommitted >= roomsNeeded) {
            skipped.push({ job, reason: 'Target already met' });
            console.log(`[Step 3.5] SKIP ${hotelName} (${hotelCode}): target already met (${roomsCommitted}/${roomsNeeded})`);
            logger.info({ hotelCode, hotelName, roomsCommitted, roomsNeeded }, 'Step 3.5: Hotel skipped — target already met');
            continue;
        }

        // Validate: supplier split exists and rooms >= 6
        if (!result?.supplierSplit?.length) {
            skipped.push({ job, reason: 'No supplier split data' });
            console.log(`[Step 3.5] SKIP ${hotelName} (${hotelCode}): no supplier split`);
            logger.info({ hotelCode, hotelName }, 'Step 3.5: Hotel skipped — no supplier split');
            continue;
        }

        // For small requests (< 6 rooms), accept any hotel covering at least 50% of the need.
        // For larger requests, keep the original floor of 6.
        const minContribution = Math.min(DEFAULT_MIN_MEANINGFUL_CONTRIBUTION, Math.max(1, Math.ceil(roomsNeeded * 0.5)));
        if (allocated < minContribution) {
            skipped.push({ job, reason: `Allocated ${allocated} rooms < ${minContribution}` });
            console.log(`[Step 3.5] SKIP ${hotelName} (${hotelCode}): rooms allocated (${allocated}) below minimum ${minContribution}`);
            logger.info({ hotelCode, hotelName, allocated, min: minContribution }, 'Step 3.5: Hotel skipped — below minimum contribution');
            continue;
        }

        // ACCEPT this hotel
        accepted.push(job);
        roomsCommitted += allocated;
        console.log(`[Step 3.5] ACCEPT ${hotelName} (${hotelCode}): +${allocated} rooms | total: ${roomsCommitted}/${roomsNeeded}`);
        logger.info(
            { hotelCode, hotelName, allocated, roomsCommitted, roomsNeeded },
            'Step 3.5: Hotel accepted',
        );
    }

    const targetMet = roomsCommitted >= roomsNeeded;
    console.log(
        `[Step 3.5] Summary: ${accepted.length} accepted, ${skipped.length} skipped, ` +
        `${roomsCommitted}/${roomsNeeded} rooms committed, target ${targetMet ? 'MET' : 'NOT MET'}`,
    );
    logger.info(
        { accepted: accepted.length, skipped: skipped.length, roomsCommitted, roomsNeeded, targetMet },
        'Step 3.5: Accumulation gate complete',
    );

    return { accepted, skipped, roomsCommitted, roomsNeeded, targetMet };
}

// ─── Service ─────────────────────────────────────────────────────────────────

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
        const roomsNeeded = countTotalRooms((request as any).rooms);
        const requestedStarRating = (request as any).starRating ? Number((request as any).starRating) : null;

        await requestRepository.updateStatus(requestId, BookingRequestStatus.processing);

        try {
            // Step 1: Queue probe jobs
            const mealType = (request as any).breakfastPreference === 'BB' ? 'BB' : undefined;
            const queueResult = await hotelSearchService.generateAutoOffer(requestId, {
                mealType,
                markupPercent: DEFAULT_MARKUP_PCT,
            });

            if (queueResult.jobsQueued === 0) {
                // "Never say no" — even after the relaxation ladder + destination
                // fallback, there are no hotels available. Flag the request so
                // staff can pick it up manually instead of the customer hitting
                // a dead end.
                if (queueResult.manualRequestOnly) {
                    await requestRepository.updateStatus(
                        requestId,
                        BookingRequestStatus.needs_manual_handling,
                    );
                }
                try {
                    await requestRepository.updateSearchPhase(requestId, 'exhausted');
                } catch (err: any) {
                    logger.warn({ err: err?.message, requestId }, 'updateSearchPhase(exhausted) failed');
                }
                const reason = queueResult.manualRequestOnly
                    ? 'No hotels found at any relaxation level — flagged for manual handling.'
                    : 'No candidate hotels found for this destination and star rating.';
                await notificationService.notifyOfferGenerationFailed({ requestId, referenceNumber: refNum, reason, staffEmail: process.env.STAFF_NOTIFICATION_EMAIL });
                return;
            }

            logger.info({ requestId, jobsQueued: queueResult.jobsQueued }, 'Waiting for probe jobs to complete');

            // Step 2: Wait for all jobs to reach a terminal state, then iterate
            // additional batches until TARGET_VIABLE_HOTELS is reached, the
            // destination is exhausted, or MAX_SEARCH_BATCHES is hit. The first
            // batch was already queued by generateAutoOffer above; this loop
            // chains follow-up batches via enqueueAdditionalCandidates.
            let jobs = await waitForJobs(requestId);
            let viableCount = await hotelProbeJobRepository.countViable(requestId);
            let paginationContext = queueResult.paginationContext;

            while (
                paginationContext &&
                viableCount < TARGET_VIABLE_HOTELS &&
                paginationContext.nextOffset < paginationContext.totalCandidates &&
                paginationContext.nextOffset < SEARCH_BATCH_SIZE * MAX_SEARCH_BATCHES
            ) {
                logger.info(
                    {
                        requestId,
                        viableSoFar: viableCount,
                        target: TARGET_VIABLE_HOTELS,
                        nextOffset: paginationContext.nextOffset,
                        totalCandidates: paginationContext.totalCandidates,
                    },
                    'Auto-offer: viable count below target — queueing next batch',
                );

                const batch = await hotelSearchService.enqueueAdditionalCandidates(
                    requestId,
                    paginationContext,
                    { mealType, markupPercent: DEFAULT_MARKUP_PCT },
                );
                if (batch.decision !== 'queued' || batch.queuedCount === 0) {
                    logger.info(
                        { requestId, decision: batch.decision, viableCount },
                        'Auto-offer: pagination stopped',
                    );
                    break;
                }

                paginationContext = { ...paginationContext, nextOffset: batch.nextOffset };
                jobs = await waitForJobs(requestId);
                viableCount = await hotelProbeJobRepository.countViable(requestId);
            }

            const completedJobs = jobs.filter((j) => (j.status as string) === 'COMPLETED');

            if (completedJobs.length === 0) {
                // All probes finished but none yielded a usable result. From the
                // customer's perspective this is the same dead end as zero
                // candidates — flag it for manual handling.
                await requestRepository.updateStatus(
                    requestId,
                    BookingRequestStatus.needs_manual_handling,
                );
                try {
                    await requestRepository.updateSearchPhase(requestId, 'exhausted');
                } catch (err: any) {
                    logger.warn({ err: err?.message, requestId }, 'updateSearchPhase(exhausted) failed');
                }
                const reason = 'No hotels with sufficient capacity found after probing — flagged for manual handling.';
                logger.warn({ requestId }, reason);
                await notificationService.notifyOfferGenerationFailed({ requestId, referenceNumber: refNum, reason, staffEmail: process.env.STAFF_NOTIFICATION_EMAIL });
                return;
            }

            // ── Step 3.5 — Accumulation Gate ──────────────────────────────────
            const requestGroupType = ((request as any).groupType as string | null | undefined) ?? null;
            const { accepted: acceptedHotels, roomsCommitted, targetMet } =
                applyAccumulationGate(completedJobs, roomsNeeded, requestedStarRating, requestGroupType);

            if (acceptedHotels.length === 0) {
                try {
                    await requestRepository.updateSearchPhase(requestId, 'exhausted');
                } catch (err: any) {
                    logger.warn({ err: err?.message, requestId }, 'updateSearchPhase(exhausted) failed');
                }
                const reason = 'No hotels passed the accumulation gate (all had < 6 rooms or no valid supplier split).';
                logger.warn({ requestId, completedJobs: completedJobs.length }, reason);
                await notificationService.notifyOfferGenerationFailed({ requestId, referenceNumber: refNum, reason, staffEmail: process.env.STAFF_NOTIFICATION_EMAIL });
                return;
            }

            // ── Bonus Alternative Detection ──────────────────────────────────
            // If a higher-star hotel is at the same or lower price than the
            // requested star, flag it as a bonus alternative for the agent.
            if (requestedStarRating) {
                // Average mid-range price of hotels matching the requested star
                const matchingPrices = acceptedHotels
                    .map((j) => j.resultJson as any)
                    .filter((r) => r.starRating === requestedStarRating && r.highestMidRangePrice > 0)
                    .map((r) => r.highestMidRangePrice as number);
                const avgRequestedPrice = matchingPrices.length > 0
                    ? matchingPrices.reduce((s, p) => s + p, 0) / matchingPrices.length
                    : 0;

                for (const job of acceptedHotels) {
                    const result = job.resultJson as any;
                    const hotelStar = result.starRating ?? 0;
                    const hotelPrice = result.highestMidRangePrice ?? 0;

                    if (hotelStar > requestedStarRating && hotelPrice > 0 && avgRequestedPrice > 0 && hotelPrice <= avgRequestedPrice) {
                        result.bonusAlternative = true;
                        result.bonusNote = `${hotelStar}-star hotel at ${requestedStarRating}-star price — better hotel, same or lower cost.`;
                        console.log(`[Bonus] ${result.hotelName}: ${hotelStar}-star at ${hotelPrice}/night vs avg ${requestedStarRating}-star at ${avgRequestedPrice.toFixed(2)}/night — flagged as bonus alternative`);
                        logger.info({
                            hotelCode: result.hotelCode, hotelName: result.hotelName,
                            hotelStar, hotelPrice, requestedStarRating, avgRequestedPrice,
                        }, 'Bonus alternative detected: higher star at same/lower price');
                    }
                }
            }

            // ── Step 4.1 — Unified Pricing Calculation ─────────────────────
            // Find the HIGHEST mid-band supplier price across ALL accepted hotels.
            // This ensures the unified selling price covers the most expensive
            // supplier in the entire split. Customer sees ONE price, not per-hotel.
            const nights = (request as any).nights ?? 1;

            let buyingPriceBase = 0;
            let unifiedCurrency = 'EUR';
            for (const job of acceptedHotels) {
                const result = job.resultJson as any;
                const hotelHighest = result?.highestMidRangePrice ?? 0;
                if (hotelHighest > buyingPriceBase) {
                    buyingPriceBase = hotelHighest;
                    unifiedCurrency = result?.currency ?? 'EUR';
                }
            }

            // Apply markup (15–20%, default 18%)
            const rawSellingPrice = buyingPriceBase * (1 + DEFAULT_MARKUP_PCT / 100);

            // Apply price psychology — Oliver's rule: avoid round numbers
            const rounded = Math.ceil(rawSellingPrice);
            let unifiedSellingPrice = rounded;
            if (rounded % 10 === 0) unifiedSellingPrice = rounded - 2;
            else if (rounded % 5 === 0) unifiedSellingPrice = rounded - 1;

            // Total offer price = unified price × total rooms × nights
            const totalOfferPrice = unifiedSellingPrice * roomsNeeded * nights;

            console.log(
                `[Step 4.1] Unified Pricing: buyingPriceBase=${buyingPriceBase} (highest across ${acceptedHotels.length} hotels), ` +
                `rawSellingPrice=${rawSellingPrice.toFixed(2)}, unifiedSellingPrice=${unifiedSellingPrice}, ` +
                `totalOfferPrice=${totalOfferPrice} (${unifiedSellingPrice} × ${roomsNeeded} rooms × ${nights} nights)`,
            );
            logger.info(
                { requestId, buyingPriceBase, rawSellingPrice, unifiedSellingPrice, totalOfferPrice, roomsNeeded, nights, markup: DEFAULT_MARKUP_PCT },
                'Step 4.1: Unified pricing calculated',
            );

            // Create proposal
            const shortfallNote = !targetMet
                ? ` Target not met — ${roomsNeeded - roomsCommitted} rooms short.`
                : '';
            const proposal = await proposalRepository.createForRequest(requestId, {
                notes: `Auto-generated offer. ${acceptedHotels.length} hotel(s) accepted (${roomsCommitted}/${roomsNeeded} rooms).${shortfallNote}`,
                markupSettings: { globalMarkupPercent: DEFAULT_MARKUP_PCT, source: 'auto' },
            });

            // Step 4.2: Add ACCEPTED hotels to the proposal — separate line items per room type (EC3)
            for (const job of acceptedHotels) {
                const result = job.resultJson as any;
                if (!result?.supplierSplit?.length) continue;

                const perTypeAllocs: any[] = result.perTypeAllocations ?? [];

                if (perTypeAllocs.length > 0) {
                    // ── Consolidated: one ProposalHotel per hotel with ALL room types bundled ──
                    // This matches the frontend's "Add Hotel" flow and avoids showing the
                    // same hotel as multiple cards in the proposal.
                    const rooms: Record<string, any> = {};
                    let hotelTotal = 0;
                    let totalAllocated = 0;
                    let cheapestAcrossTypes: any = null;

                    for (const typeAlloc of perTypeAllocs) {
                        if (typeAlloc.roomsAllocated <= 0) continue;

                        const typeSplitEntries = (result.supplierSplit ?? [])
                            .filter((e: any) => e.roomType === typeAlloc.roomType);
                        const cheapest = [...typeSplitEntries].sort(
                            (a: any, b: any) => a.pricePerRoomPerNight - b.pricePerRoomPerNight,
                        )[0] as any;
                        if (!cheapest) continue;

                        const typeTotal = unifiedSellingPrice * typeAlloc.roomsAllocated * nights;
                        hotelTotal += typeTotal;
                        totalAllocated += typeAlloc.roomsAllocated;

                        // Track the cheapest entry across all room types for the hotel-level
                        // TID/supplierCode fields.
                        if (!cheapestAcrossTypes || cheapest.pricePerRoomPerNight < cheapestAcrossTypes.pricePerRoomPerNight) {
                            cheapestAcrossTypes = cheapest;
                        }

                        rooms[typeAlloc.roomType] = {
                            net: cheapest.pricePerRoomPerNight,
                            sell: unifiedSellingPrice,
                            qty: typeAlloc.roomsAllocated,
                            nights,
                            actualDescriptions: typeAlloc.actualDescriptions ?? [],
                            ...(result.bonusAlternative ? { bonusAlternative: true, bonusNote: result.bonusNote } : {}),
                        };
                    }

                    if (!cheapestAcrossTypes || totalAllocated === 0) continue;

                    console.log(
                        `[Step 4.2] Adding ${result.hotelName}: ${totalAllocated} rooms across ${Object.keys(rooms).length} room type(s) × ${unifiedSellingPrice}/night × ${nights} nights = ${hotelTotal} ${unifiedCurrency}`,
                    );

                    const hotelNameWithBonus = result.bonusAlternative
                        ? `${result.hotelName ?? result.hotelCode} ★ BONUS`
                        : (result.hotelName ?? undefined);

                    await proposalRepository.addHotelTx(proposal.id, {
                        hotelCode: result.hotelCode,
                        hotelName: hotelNameWithBonus,
                        tid: cheapestAcrossTypes.tid,
                        currency: unifiedCurrency,
                        totalPrice: hotelTotal,
                        freeCancellation: true,
                        cancelDeadline: result.cxlDeadline ?? null,
                        supplierCode: cheapestAcrossTypes.supplierCode,
                        latitude: result.latitude ?? null,
                        longitude: result.longitude ?? null,
                        starRating: result.starRating ?? null,
                        address: result.address ?? null,
                        addressCity: result.addressCity ?? null,
                        addressCountry: result.addressCountry ?? null,
                        rooms,
                    });
                } else {
                    // ── Fallback: old-style single aggregate entry ─────────────
                    const cheapestSplit = [...result.supplierSplit].sort(
                        (a: any, b: any) => a.pricePerRoomPerNight - b.pricePerRoomPerNight,
                    )[0] as any;
                    if (!cheapestSplit) continue;

                    const roomsQty = result.roomsAllocated ?? job.requestedRooms;
                    const hotelTotal = unifiedSellingPrice * roomsQty * nights;

                    console.log(
                        `[Step 4.2] Adding ${result.hotelName} (${result.hotelCode}): ${roomsQty} rooms × ${unifiedSellingPrice}/night × ${nights} nights = ${hotelTotal} ${unifiedCurrency} (aggregate fallback)`,
                    );

                    const legacyName = result.bonusAlternative
                        ? `${result.hotelName ?? result.hotelCode} ★ BONUS`
                        : (result.hotelName ?? undefined);

                    await proposalRepository.addHotelTx(proposal.id, {
                        hotelCode: result.hotelCode,
                        hotelName: legacyName,
                        tid: cheapestSplit.tid,
                        currency: unifiedCurrency,
                        totalPrice: hotelTotal,
                        freeCancellation: true,
                        cancelDeadline: result.cxlDeadline ?? null,
                        supplierCode: cheapestSplit.supplierCode,
                        latitude: result.latitude ?? null,
                        longitude: result.longitude ?? null,
                        starRating: result.starRating ?? null,
                        address: result.address ?? null,
                        addressCity: result.addressCity ?? null,
                        addressCountry: result.addressCountry ?? null,
                        rooms: {
                            standard: {
                                net: cheapestSplit.pricePerRoomPerNight,
                                sell: unifiedSellingPrice,
                                qty: roomsQty,
                                nights,
                                ...(result.bonusAlternative ? { bonusAlternative: true, bonusNote: result.bonusNote } : {}),
                            },
                        },
                    });
                }
            }

            // ── Step 4.2 — Set proposal to PENDING_ADMIN_APPROVAL ────────
            // Offer saved to DB with status: PENDING_ADMIN_APPROVAL
            // Admin must review and approve/decline before it goes to the agent.
            await proposalRepository.setPendingAdminApproval(proposal.id);
            console.log(`[Step 4.2] Proposal ${proposal.id} set to PENDING_ADMIN_APPROVAL`);

            // ── Accumulation Gate Decision + Notifications ───────────────────
            if (targetMet) {
                // SUCCESS — target met, offer ready for admin review
                console.log(`[Step 4.2] SUCCESS: Target met — ${roomsCommitted}/${roomsNeeded} rooms across ${acceptedHotels.length} hotel(s). Awaiting admin approval.`);
                logger.info(
                    { requestId, proposalId: proposal.id, hotelsAccepted: acceptedHotels.length, roomsCommitted, roomsNeeded, totalOfferPrice },
                    'Step 4.2: Target met — proposal pending admin approval',
                );

                await requestRepository.updateStatus(requestId, BookingRequestStatus.ai_generated);
                try {
                    await requestRepository.updateSearchPhase(requestId, 'settled');
                } catch (err: any) {
                    logger.warn({ err: err?.message, requestId }, 'updateSearchPhase(settled) failed');
                }

                await notificationService.notifyNewOfferReady({
                    requestId,
                    referenceNumber: refNum,
                    contactName,
                    destinationName,
                    staffEmail: process.env.STAFF_NOTIFICATION_EMAIL,
                });
            } else {
                // ESCALATE TO HUMAN — target not met, partial offer saved for review
                const roomsMissing = roomsNeeded - roomsCommitted;
                const suggestion = roomsMissing <= 10
                    ? 'Try ±1 star rating or adjacent dates to find additional availability.'
                    : 'Consider adding a nearby destination or contacting hotel chains directly for large-block availability.';

                console.log(`[Step 4.2] ESCALATE TO HUMAN: ${roomsCommitted}/${roomsNeeded} rooms (${roomsMissing} missing) across ${acceptedHotels.length} hotel(s). Suggestion: ${suggestion}`);
                logger.warn(
                    { requestId, proposalId: proposal.id, hotelsAccepted: acceptedHotels.length, roomsCommitted, roomsNeeded, roomsMissing, suggestion },
                    'Step 4.2: Target not met — escalating to human with partial offer',
                );

                await requestRepository.updateStatus(requestId, BookingRequestStatus.ai_generated);
                try {
                    await requestRepository.updateSearchPhase(requestId, 'settled');
                } catch (err: any) {
                    logger.warn({ err: err?.message, requestId }, 'updateSearchPhase(settled) failed');
                }

                await notificationService.notifyInsufficientInventory({
                    requestId,
                    referenceNumber: refNum,
                    contactName,
                    destinationName,
                    roomsNeeded,
                    roomsFound: roomsCommitted,
                    roomsMissing,
                    hotelsAccepted: acceptedHotels.length,
                    suggestion,
                    staffEmail: process.env.STAFF_NOTIFICATION_EMAIL,
                });
            }
        } catch (err: any) {
            logger.error({ err, requestId }, 'AI offer generation failed');
            try {
                await requestRepository.updateSearchPhase(requestId, 'exhausted');
            } catch (phaseErr: any) {
                logger.warn({ err: phaseErr?.message, requestId }, 'updateSearchPhase(exhausted) after error failed');
            }
            await notificationService.notifyOfferGenerationFailed({
                requestId,
                referenceNumber: refNum,
                reason: err?.message ?? 'Unknown error',
                staffEmail: process.env.STAFF_NOTIFICATION_EMAIL,
            });
        }
    }
}

export default new OfferGenerationService();

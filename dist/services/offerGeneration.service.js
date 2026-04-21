"use strict";
/**
 * Offer Generation Service
 *
 * Triggers the queue-based hotel probe pipeline, waits for all jobs to finish,
 * then applies Step 3.5 accumulation gate (accept/skip hotels until target met),
 * builds a proposal from the accepted hotels, and notifies staff.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OfferGenerationService = void 0;
const hotelSearch_service_1 = __importDefault(require("./hotelSearch.service"));
const notification_service_1 = __importDefault(require("./notification.service"));
const request_repository_1 = __importDefault(require("../repositories/request.repository"));
const proposal_repository_1 = __importDefault(require("../repositories/proposal.repository"));
const hotelProbeJob_repository_1 = __importDefault(require("../repositories/hotelProbeJob.repository"));
const logger_1 = __importDefault(require("../utils/logger"));
const roomUtils_1 = require("../utils/roomUtils");
const client_1 = require("@prisma/client");
const DEFAULT_MARKUP_PCT = 18;
/** Max time to wait for all probe jobs to complete (ms). */
const JOB_WAIT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const JOB_POLL_INTERVAL_MS = 5000; // 5 seconds
const DEFAULT_MIN_MEANINGFUL_CONTRIBUTION = 6;
const TERMINAL_STATUSES = new Set(['COMPLETED', 'SKIPPED_INSUFFICIENT', 'FAILED']);
async function waitForJobs(searchRequestId) {
    const deadline = Date.now() + JOB_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, JOB_POLL_INTERVAL_MS));
        const jobs = await hotelProbeJob_repository_1.default.findBySearchRequest(searchRequestId);
        const pending = jobs.filter((j) => !TERMINAL_STATUSES.has(j.status));
        if (pending.length === 0)
            return jobs;
    }
    // Timeout — return whatever we have
    return hotelProbeJob_repository_1.default.findBySearchRequest(searchRequestId);
}
/**
 * Step 3.5 — Cross-hotel accumulation gate.
 *
 * Sorts completed hotels by priority (star match → capacity status → rooms → price),
 * accepts hotels one by one, tracks rooms_committed, and stops once the target is met.
 * Remaining hotels are skipped with "target already met".
 */
function applyAccumulationGate(completedJobs, roomsNeeded, requestedStarRating) {
    const statusOrder = { CONFIRMED: 0, LIMITED: 1 };
    // Sort: star match first → CONFIRMED before LIMITED → most rooms → cheapest price
    const sorted = [...completedJobs].sort((a, b) => {
        const ra = a.resultJson;
        const rb = b.resultJson;
        // Primary: star rating match
        const aStarMatch = requestedStarRating != null && ra.starRating === requestedStarRating ? 0 : 1;
        const bStarMatch = requestedStarRating != null && rb.starRating === requestedStarRating ? 0 : 1;
        if (aStarMatch !== bStarMatch)
            return aStarMatch - bStarMatch;
        // Secondary: CONFIRMED before LIMITED
        const aStatus = statusOrder[ra.capacityStatus] ?? 2;
        const bStatus = statusOrder[rb.capacityStatus] ?? 2;
        if (aStatus !== bStatus)
            return aStatus - bStatus;
        // Tertiary: more rooms first (fills target faster)
        const aRooms = ra.roomsAllocated ?? 0;
        const bRooms = rb.roomsAllocated ?? 0;
        if (bRooms !== aRooms)
            return bRooms - aRooms;
        // Quaternary: cheaper price first
        return (ra.sellingPricePerRoomPerNight ?? 0) - (rb.sellingPricePerRoomPerNight ?? 0);
    });
    const accepted = [];
    const skipped = [];
    let roomsCommitted = 0;
    console.log(`[Step 3.5] Starting accumulation gate: ${sorted.length} completed hotels, roomsNeeded=${roomsNeeded}`);
    logger_1.default.info({ completedCount: sorted.length, roomsNeeded, requestedStarRating }, 'Step 3.5: Starting accumulation gate');
    for (const job of sorted) {
        const result = job.resultJson;
        const hotelName = result?.hotelName ?? result?.hotelCode ?? 'Unknown';
        const hotelCode = result?.hotelCode ?? '';
        const allocated = result?.roomsAllocated ?? 0;
        // Early exit — target already met
        if (roomsCommitted >= roomsNeeded) {
            skipped.push({ job, reason: 'Target already met' });
            console.log(`[Step 3.5] SKIP ${hotelName} (${hotelCode}): target already met (${roomsCommitted}/${roomsNeeded})`);
            logger_1.default.info({ hotelCode, hotelName, roomsCommitted, roomsNeeded }, 'Step 3.5: Hotel skipped — target already met');
            continue;
        }
        // Validate: supplier split exists and rooms >= 6
        if (!result?.supplierSplit?.length) {
            skipped.push({ job, reason: 'No supplier split data' });
            console.log(`[Step 3.5] SKIP ${hotelName} (${hotelCode}): no supplier split`);
            logger_1.default.info({ hotelCode, hotelName }, 'Step 3.5: Hotel skipped — no supplier split');
            continue;
        }
        // For small requests (< 6 rooms), accept any hotel covering at least 50% of the need.
        // For larger requests, keep the original floor of 6.
        const minContribution = Math.min(DEFAULT_MIN_MEANINGFUL_CONTRIBUTION, Math.max(1, Math.ceil(roomsNeeded * 0.5)));
        if (allocated < minContribution) {
            skipped.push({ job, reason: `Allocated ${allocated} rooms < ${minContribution}` });
            console.log(`[Step 3.5] SKIP ${hotelName} (${hotelCode}): rooms allocated (${allocated}) below minimum ${minContribution}`);
            logger_1.default.info({ hotelCode, hotelName, allocated, min: minContribution }, 'Step 3.5: Hotel skipped — below minimum contribution');
            continue;
        }
        // ACCEPT this hotel
        accepted.push(job);
        roomsCommitted += allocated;
        console.log(`[Step 3.5] ACCEPT ${hotelName} (${hotelCode}): +${allocated} rooms | total: ${roomsCommitted}/${roomsNeeded}`);
        logger_1.default.info({ hotelCode, hotelName, allocated, roomsCommitted, roomsNeeded }, 'Step 3.5: Hotel accepted');
    }
    const targetMet = roomsCommitted >= roomsNeeded;
    console.log(`[Step 3.5] Summary: ${accepted.length} accepted, ${skipped.length} skipped, ` +
        `${roomsCommitted}/${roomsNeeded} rooms committed, target ${targetMet ? 'MET' : 'NOT MET'}`);
    logger_1.default.info({ accepted: accepted.length, skipped: skipped.length, roomsCommitted, roomsNeeded, targetMet }, 'Step 3.5: Accumulation gate complete');
    return { accepted, skipped, roomsCommitted, roomsNeeded, targetMet };
}
// ─── Service ─────────────────────────────────────────────────────────────────
class OfferGenerationService {
    /**
     * Trigger the full offer generation pipeline asynchronously (fire-and-forget).
     */
    triggerAsync(requestId) {
        setImmediate(() => {
            this.run(requestId).catch((err) => {
                logger_1.default.error({ err, requestId }, 'Unhandled error in offer generation pipeline');
            });
        });
    }
    async run(requestId) {
        logger_1.default.info({ requestId }, 'Starting AI offer generation');
        const request = await request_repository_1.default.findById(requestId);
        if (!request) {
            logger_1.default.error({ requestId }, 'Booking request not found for offer generation');
            return;
        }
        const refNum = request.referenceNumber;
        const contactName = request.contactName ?? request.firstName ?? 'Guest';
        const destinationName = request.destinationName ?? 'Unknown destination';
        const roomsNeeded = (0, roomUtils_1.countTotalRooms)(request.rooms);
        const requestedStarRating = request.starRating ? Number(request.starRating) : null;
        const assignedUserId = request.assignedUserId ?? undefined;
        await request_repository_1.default.updateStatus(requestId, client_1.BookingRequestStatus.processing);
        try {
            // Step 1: Queue probe jobs
            const mealType = request.breakfastPreference === 'BB' ? 'BB' : undefined;
            const queueResult = await hotelSearch_service_1.default.generateAutoOffer(requestId, {
                mealType,
                markupPercent: DEFAULT_MARKUP_PCT,
            });
            if (queueResult.jobsQueued === 0) {
                const reason = 'No candidate hotels found for this destination and star rating.';
                await notification_service_1.default.notifyOfferGenerationFailed({ requestId, referenceNumber: refNum, reason, staffEmail: process.env.STAFF_NOTIFICATION_EMAIL });
                return;
            }
            logger_1.default.info({ requestId, jobsQueued: queueResult.jobsQueued }, 'Waiting for probe jobs to complete');
            // Step 2: Wait for all jobs to reach a terminal state
            const jobs = await waitForJobs(requestId);
            const completedJobs = jobs.filter((j) => j.status === 'COMPLETED');
            if (completedJobs.length === 0) {
                const reason = 'No hotels with sufficient capacity found after probing.';
                logger_1.default.warn({ requestId }, reason);
                await notification_service_1.default.notifyOfferGenerationFailed({ requestId, referenceNumber: refNum, reason, staffEmail: process.env.STAFF_NOTIFICATION_EMAIL });
                return;
            }
            // ── Step 3.5 — Accumulation Gate ──────────────────────────────────
            const { accepted: acceptedHotels, roomsCommitted, targetMet } = applyAccumulationGate(completedJobs, roomsNeeded, requestedStarRating);
            if (acceptedHotels.length === 0) {
                const reason = 'No hotels passed the accumulation gate (all had < 6 rooms or no valid supplier split).';
                logger_1.default.warn({ requestId, completedJobs: completedJobs.length }, reason);
                await notification_service_1.default.notifyOfferGenerationFailed({ requestId, referenceNumber: refNum, reason, staffEmail: process.env.STAFF_NOTIFICATION_EMAIL });
                return;
            }
            // ── Bonus Alternative Detection ──────────────────────────────────
            // If a higher-star hotel is at the same or lower price than the
            // requested star, flag it as a bonus alternative for the agent.
            if (requestedStarRating) {
                // Average mid-range price of hotels matching the requested star
                const matchingPrices = acceptedHotels
                    .map((j) => j.resultJson)
                    .filter((r) => r.starRating === requestedStarRating && r.highestMidRangePrice > 0)
                    .map((r) => r.highestMidRangePrice);
                const avgRequestedPrice = matchingPrices.length > 0
                    ? matchingPrices.reduce((s, p) => s + p, 0) / matchingPrices.length
                    : 0;
                for (const job of acceptedHotels) {
                    const result = job.resultJson;
                    const hotelStar = result.starRating ?? 0;
                    const hotelPrice = result.highestMidRangePrice ?? 0;
                    if (hotelStar > requestedStarRating && hotelPrice > 0 && avgRequestedPrice > 0 && hotelPrice <= avgRequestedPrice) {
                        result.bonusAlternative = true;
                        result.bonusNote = `${hotelStar}-star hotel at ${requestedStarRating}-star price — better hotel, same or lower cost.`;
                        console.log(`[Bonus] ${result.hotelName}: ${hotelStar}-star at ${hotelPrice}/night vs avg ${requestedStarRating}-star at ${avgRequestedPrice.toFixed(2)}/night — flagged as bonus alternative`);
                        logger_1.default.info({
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
            const nights = request.nights ?? 1;
            let buyingPriceBase = 0;
            let unifiedCurrency = 'EUR';
            for (const job of acceptedHotels) {
                const result = job.resultJson;
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
            if (rounded % 10 === 0)
                unifiedSellingPrice = rounded - 2;
            else if (rounded % 5 === 0)
                unifiedSellingPrice = rounded - 1;
            // Total offer price = unified price × total rooms × nights
            const totalOfferPrice = unifiedSellingPrice * roomsNeeded * nights;
            console.log(`[Step 4.1] Unified Pricing: buyingPriceBase=${buyingPriceBase} (highest across ${acceptedHotels.length} hotels), ` +
                `rawSellingPrice=${rawSellingPrice.toFixed(2)}, unifiedSellingPrice=${unifiedSellingPrice}, ` +
                `totalOfferPrice=${totalOfferPrice} (${unifiedSellingPrice} × ${roomsNeeded} rooms × ${nights} nights)`);
            logger_1.default.info({ requestId, buyingPriceBase, rawSellingPrice, unifiedSellingPrice, totalOfferPrice, roomsNeeded, nights, markup: DEFAULT_MARKUP_PCT }, 'Step 4.1: Unified pricing calculated');
            // Create proposal
            const shortfallNote = !targetMet
                ? ` Target not met — ${roomsNeeded - roomsCommitted} rooms short.`
                : '';
            const proposal = await proposal_repository_1.default.createForRequest(requestId, {
                notes: `Auto-generated offer. ${acceptedHotels.length} hotel(s) accepted (${roomsCommitted}/${roomsNeeded} rooms).${shortfallNote}`,
                markupSettings: { globalMarkupPercent: DEFAULT_MARKUP_PCT, source: 'auto' },
            });
            // Step 4.2: Add ACCEPTED hotels to the proposal — separate line items per room type (EC3)
            for (const job of acceptedHotels) {
                const result = job.resultJson;
                if (!result?.supplierSplit?.length)
                    continue;
                const perTypeAllocs = result.perTypeAllocations ?? [];
                if (perTypeAllocs.length > 0) {
                    // ── EC3: Per-room-type entries ──────────────────────────────
                    for (const typeAlloc of perTypeAllocs) {
                        if (typeAlloc.roomsAllocated <= 0)
                            continue;
                        // Find the cheapest supplier for THIS room type
                        const typeSplitEntries = (result.supplierSplit ?? [])
                            .filter((e) => e.roomType === typeAlloc.roomType);
                        const cheapest = [...typeSplitEntries].sort((a, b) => a.pricePerRoomPerNight - b.pricePerRoomPerNight)[0];
                        if (!cheapest)
                            continue;
                        const typeTotal = unifiedSellingPrice * typeAlloc.roomsAllocated * nights;
                        console.log(`[Step 4.2] Adding ${result.hotelName} — ${typeAlloc.roomType}: ${typeAlloc.roomsAllocated} rooms × ${unifiedSellingPrice}/night × ${nights} nights = ${typeTotal} ${unifiedCurrency}`);
                        // Include bonus alternative flag if detected
                        const hotelNameWithBonus = result.bonusAlternative
                            ? `${result.hotelName ?? result.hotelCode} ★ BONUS`
                            : (result.hotelName ?? undefined);
                        await proposal_repository_1.default.addHotelTx(proposal.id, {
                            hotelCode: result.hotelCode,
                            hotelName: hotelNameWithBonus,
                            tid: cheapest.tid,
                            currency: unifiedCurrency,
                            totalPrice: typeTotal,
                            freeCancellation: true,
                            cancelDeadline: result.cxlDeadline ?? null,
                            supplierCode: cheapest.supplierCode,
                            latitude: result.latitude ?? null,
                            longitude: result.longitude ?? null,
                            rooms: {
                                [typeAlloc.roomType]: {
                                    net: cheapest.pricePerRoomPerNight,
                                    sell: unifiedSellingPrice,
                                    qty: typeAlloc.roomsAllocated,
                                    nights,
                                    // M5 — Store the actual WBE room names so the UI
                                    // shows what the supplier actually returned (e.g.
                                    // "Double Room, Terrace") instead of just the
                                    // requested type label (e.g. "Single").
                                    actualDescriptions: typeAlloc.actualDescriptions ?? [],
                                    ...(result.bonusAlternative ? { bonusAlternative: true, bonusNote: result.bonusNote } : {}),
                                },
                            },
                        });
                    }
                }
                else {
                    // ── Fallback: old-style single aggregate entry ─────────────
                    const cheapestSplit = [...result.supplierSplit].sort((a, b) => a.pricePerRoomPerNight - b.pricePerRoomPerNight)[0];
                    if (!cheapestSplit)
                        continue;
                    const roomsQty = result.roomsAllocated ?? job.requestedRooms;
                    const hotelTotal = unifiedSellingPrice * roomsQty * nights;
                    console.log(`[Step 4.2] Adding ${result.hotelName} (${result.hotelCode}): ${roomsQty} rooms × ${unifiedSellingPrice}/night × ${nights} nights = ${hotelTotal} ${unifiedCurrency} (aggregate fallback)`);
                    const legacyName = result.bonusAlternative
                        ? `${result.hotelName ?? result.hotelCode} ★ BONUS`
                        : (result.hotelName ?? undefined);
                    await proposal_repository_1.default.addHotelTx(proposal.id, {
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
            await proposal_repository_1.default.setPendingAdminApproval(proposal.id);
            console.log(`[Step 4.2] Proposal ${proposal.id} set to PENDING_ADMIN_APPROVAL`);
            // ── Accumulation Gate Decision + Notifications ───────────────────
            if (targetMet) {
                // SUCCESS — target met, offer ready for admin review
                console.log(`[Step 4.2] SUCCESS: Target met — ${roomsCommitted}/${roomsNeeded} rooms across ${acceptedHotels.length} hotel(s). Awaiting admin approval.`);
                logger_1.default.info({ requestId, proposalId: proposal.id, hotelsAccepted: acceptedHotels.length, roomsCommitted, roomsNeeded, totalOfferPrice }, 'Step 4.2: Target met — proposal pending admin approval');
                await request_repository_1.default.updateStatus(requestId, client_1.BookingRequestStatus.ai_generated);
                await notification_service_1.default.notifyNewOfferReady({
                    requestId,
                    referenceNumber: refNum,
                    contactName,
                    destinationName,
                    staffEmail: process.env.STAFF_NOTIFICATION_EMAIL,
                });
            }
            else {
                // ESCALATE TO HUMAN — target not met, partial offer saved for review
                const roomsMissing = roomsNeeded - roomsCommitted;
                const suggestion = roomsMissing <= 10
                    ? 'Try ±1 star rating or adjacent dates to find additional availability.'
                    : 'Consider adding a nearby destination or contacting hotel chains directly for large-block availability.';
                console.log(`[Step 4.2] ESCALATE TO HUMAN: ${roomsCommitted}/${roomsNeeded} rooms (${roomsMissing} missing) across ${acceptedHotels.length} hotel(s). Suggestion: ${suggestion}`);
                logger_1.default.warn({ requestId, proposalId: proposal.id, hotelsAccepted: acceptedHotels.length, roomsCommitted, roomsNeeded, roomsMissing, suggestion }, 'Step 4.2: Target not met — escalating to human with partial offer');
                await request_repository_1.default.updateStatus(requestId, client_1.BookingRequestStatus.ai_generated);
                await notification_service_1.default.notifyInsufficientInventory({
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
        }
        catch (err) {
            logger_1.default.error({ err, requestId }, 'AI offer generation failed');
            await notification_service_1.default.notifyOfferGenerationFailed({
                requestId,
                referenceNumber: refNum,
                reason: err?.message ?? 'Unknown error',
                staffEmail: process.env.STAFF_NOTIFICATION_EMAIL,
            });
        }
    }
}
exports.OfferGenerationService = OfferGenerationService;
exports.default = new OfferGenerationService();

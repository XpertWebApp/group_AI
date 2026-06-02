import { PrismaClient, ProposalStatus, Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { floorStarRating } from '../utils/starRating';
import { buildSethubDetailsUrl } from '../config/sethubUrl';

const prisma = new PrismaClient();

// Lock timeout in minutes
const LOCK_TIMEOUT_MINUTES = 15;

/** Recalculate proposal totals from live hotel + service rows.
 *  Only items where includedInTotal = true are summed (Oliver's "options" feature). */
async function recalcTotals(
    tx: Prisma.TransactionClient,
    proposalId: string,
    markupSettings?: any,
): Promise<{ totalBuy: Decimal; totalSell: Decimal }> {
    // Sum active (non-deleted) hotel totalPrice → buy side, ONLY hotels marked included
    const hotelAgg = await tx.proposalHotel.aggregate({
        where: { proposalId, deletedAt: null, includedInTotal: true },
        _sum: { totalPrice: true },
    });
    // Sum service buyPrice * quantity ONLY for services marked included
    const services = await tx.proposalService.findMany({
        where: { proposalId, includedInTotal: true },
        select: { buyPrice: true, sellPrice: true, quantity: true },
    });

    let hotelBuy = new Decimal(hotelAgg._sum.totalPrice?.toString() ?? '0');
    let serviceBuy = new Decimal(0);
    let serviceSell = new Decimal(0);

    for (const s of services) {
        const qty = new Decimal(s.quantity ?? 1);
        serviceBuy = serviceBuy.plus(new Decimal(s.buyPrice?.toString() ?? '0').mul(qty));
        serviceSell = serviceSell.plus(new Decimal(s.sellPrice?.toString() ?? '0').mul(qty));
    }

    const totalBuy = hotelBuy.plus(serviceBuy);

    // totalSell = apply globalMarkupPercent to totalBuy (hotel side) then add service sell prices
    let totalSell: Decimal;
    // New proposals always snapshot the live `defaultMarkupPercentage` from
    // /settings/general into their `markupSettings.globalMarkupPercent` at
    // create time (see offerGeneration.service.ts). This fallback only fires
    // for legacy proposals that were created before the snapshot was written.
    // Keep the literal 18 % here so re-aggregating an old proposal yields
    // the same total it was originally sent at — do NOT read live settings.
    const globalMarkupPercent = markupSettings?.globalMarkupPercent ?? 18;
    const hotelSell = hotelBuy.mul(new Decimal(1).plus(new Decimal(globalMarkupPercent).div(100)));
    totalSell = hotelSell.plus(serviceSell);

    return { totalBuy, totalSell };
}

export class ProposalRepository {
    async findAll() {
        return prisma.proposal.findMany({
            include: { bookingRequest: true },
            orderBy: { createdAt: 'desc' },
        });
    }

    async findById(id: string) {
        return prisma.proposal.findUnique({
            where: { id },
            include: {
                bookingRequest: true,
                hotels: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
                services: { orderBy: { createdAt: 'asc' } },
            },
        });
    }

    async findHotels(proposalId: string) {
        return prisma.proposalHotel.findMany({
            where: { proposalId, deletedAt: null },
            orderBy: { createdAt: 'asc' },
        });
    }

    async createForRequest(requestId: string, data: { notes?: string; markupSettings?: any }) {
        return prisma.proposal.create({
            data: {
                requestId,
                status: ProposalStatus.draft,
                notes: data.notes,
                markupSettings: data.markupSettings ?? undefined,
                totalBuy: 0,
                totalSell: 0,
            },
        });
    }

    async create(data: any) {
        return prisma.proposal.create({ data });
    }

    async update(id: string, data: any) {
        return prisma.proposal.update({
            where: { id },
            data: { ...data, updatedAt: new Date() },
        });
    }

    async updateMetadata(id: string, data: { notes?: string; markupSettings?: any }) {
        return prisma.proposal.update({
            where: { id },
            data: {
                ...(data.notes !== undefined && { notes: data.notes }),
                ...(data.markupSettings !== undefined && { markupSettings: data.markupSettings }),
            },
        });
    }

    /**
     * Atomically adds a hotel and recalculates proposal totals.
     * Uses a Prisma transaction so the insert + totals update are an atomic unit.
     */
    async addHotelTx(
        proposalId: string,
        hotelData: {
            hotelCode: string;
            hotelName?: string;
            tid?: string;
            rooms?: any;
            currency: string;
            totalPrice: number;
            freeCancellation?: boolean;
            cancelDeadline?: string | null;
            supplierCode?: string;
            optionDetailsId?: string;
            latitude?: number | null;
            longitude?: number | null;
            starRating?: number | null;
            address?: string | null;
            addressCity?: string | null;
            addressCountry?: string | null;
            /** Optional SETTHub deep-link URL — see persistence logic below. */
            sethubDetailsUrl?: string | null;
        },
        markupSettings?: any,
    ) {
        return prisma.$transaction(async (tx) => {
            // Check for option detail in cache
            let optionDetailsFetched = false;
            if (hotelData.optionDetailsId) {
                const cached = await tx.hotelOptionDetail.findUnique({
                    where: { id: hotelData.optionDetailsId } as any,
                });
                optionDetailsFetched = !!cached;
            } else if (hotelData.tid) {
                const cachedByTid = await tx.hotelOptionDetail.findUnique({
                    where: { tid: hotelData.tid },
                });
                optionDetailsFetched = !!cachedByTid;
            }

            // Generate stable hotel reference: SETT-{requestRef}-{seq 3-digit}.
            // Counts ALL rows (including soft-deleted) so refs are append-only and never collide.
            const parent = await tx.proposal.findUnique({
                where: { id: proposalId },
                select: { bookingRequest: { select: { referenceNumber: true } } },
            });
            const refNum = parent?.bookingRequest?.referenceNumber;
            const count = await tx.proposalHotel.count({ where: { proposalId } });
            const seq = String(count + 1).padStart(3, '0');
            const hotelRef = refNum ? `SETT-${refNum}-${seq}` : null;

            // SETTHub deep-link URL. Prefer the value the FE forwarded
            // (which it sourced from the hotel-search response, so it's
            // already computed against `masterHotelId`). When the FE
            // doesn't send it (older clients, automation paths), derive
            // it on the fly from `master.hotels.masterHotelId`. Null when
            // the hotel has no synced master ID — the dashboard renders
            // a plain heading in that case.
            let sethubDetailsUrl: string | null = hotelData.sethubDetailsUrl ?? null;
            if (!sethubDetailsUrl) {
                const masterHotel = await tx.hotel.findUnique({
                    where: { hotelCode: hotelData.hotelCode },
                    select: { masterHotelId: true },
                });
                sethubDetailsUrl = buildSethubDetailsUrl(masterHotel?.masterHotelId ?? null);
            }

            const hotel = await tx.proposalHotel.create({
                data: {
                    proposalId,
                    hotelCode: hotelData.hotelCode,
                    hotelName: hotelData.hotelName ?? null,
                    tid: hotelData.tid ?? null,
                    rooms: hotelData.rooms ?? Prisma.JsonNull,
                    currency: hotelData.currency,
                    totalPrice: new Decimal(hotelData.totalPrice).toFixed(2),
                    freeCancellation: hotelData.freeCancellation ?? null,
                    cancelDeadline: hotelData.cancelDeadline
                        ? new Date(hotelData.cancelDeadline)
                        : null,
                    supplierCode: hotelData.supplierCode ?? null,
                    optionDetailsId: hotelData.optionDetailsId ?? null,
                    optionDetailsFetched,
                    latitude: hotelData.latitude != null ? new Decimal(hotelData.latitude).toFixed(7) : null,
                    longitude: hotelData.longitude != null ? new Decimal(hotelData.longitude).toFixed(7) : null,
                    starRating: floorStarRating(hotelData.starRating ?? null),
                    address: hotelData.address ?? null,
                    addressCity: hotelData.addressCity ?? null,
                    addressCountry: hotelData.addressCountry ?? null,
                    hotelRef,
                    sethubDetailsUrl,
                },
            });

            const proposal = await tx.proposal.findUnique({ where: { id: proposalId }, select: { markupSettings: true } });
            const { totalBuy, totalSell } = await recalcTotals(tx, proposalId, proposal?.markupSettings ?? markupSettings);

            const updatedProposal = await tx.proposal.update({
                where: { id: proposalId },
                data: { totalBuy: totalBuy.toFixed(2), totalSell: totalSell.toFixed(2) },
            });

            return { hotel, proposal: updatedProposal };
        });
    }

    /**
     * Soft-deletes a proposal hotel and recalculates totals atomically.
     */
    async removeHotelTx(
        proposalId: string,
        hotelId: string,
        snapshot: any,
    ) {
        return prisma.$transaction(async (tx) => {
            const hotel = await tx.proposalHotel.update({
                where: { id: hotelId },
                data: { deletedAt: new Date() },
            });

            const proposal = await tx.proposal.findUnique({ where: { id: proposalId }, select: { markupSettings: true } });
            const { totalBuy, totalSell } = await recalcTotals(tx, proposalId, proposal?.markupSettings);

            const updatedProposal = await tx.proposal.update({
                where: { id: proposalId },
                data: { totalBuy: totalBuy.toFixed(2), totalSell: totalSell.toFixed(2) },
            });

            return { hotel, proposal: updatedProposal };
        });
    }

    /**
     * Adds a service and recalculates totals atomically.
     */
    async addServiceTx(
        proposalId: string,
        serviceData: {
            serviceName: string;
            dateFrom?: string | null;
            dateTo?: string | null;
            buyPrice?: number;
            sellPrice?: number;
            quantity?: number;
            days?: number;
            notes?: string;
        },
        markupSettings?: any,
    ) {
        return prisma.$transaction(async (tx) => {
            const service = await tx.proposalService.create({
                data: {
                    proposalId,
                    serviceName: serviceData.serviceName,
                    dateFrom: serviceData.dateFrom ? new Date(serviceData.dateFrom) : null,
                    dateTo: serviceData.dateTo ? new Date(serviceData.dateTo) : null,
                    buyPrice: serviceData.buyPrice !== undefined ? new Decimal(serviceData.buyPrice).toFixed(2) : null,
                    sellPrice: serviceData.sellPrice !== undefined ? new Decimal(serviceData.sellPrice).toFixed(2) : null,
                    quantity: serviceData.quantity ?? null,
                    days: serviceData.days ?? null,
                    notes: serviceData.notes ?? null,
                },
            });

            const proposal = await tx.proposal.findUnique({ where: { id: proposalId }, select: { markupSettings: true } });
            const { totalBuy, totalSell } = await recalcTotals(tx, proposalId, proposal?.markupSettings ?? markupSettings);

            const updatedProposal = await tx.proposal.update({
                where: { id: proposalId },
                data: { totalBuy: totalBuy.toFixed(2), totalSell: totalSell.toFixed(2) },
            });

            return { service, proposal: updatedProposal };
        });
    }

    /**
     * Updates a service and recalculates totals atomically.
     */
    async updateServiceTx(
        proposalId: string,
        serviceId: string,
        serviceData: {
            serviceName?: string;
            dateFrom?: string | null;
            dateTo?: string | null;
            buyPrice?: number;
            sellPrice?: number;
            quantity?: number;
            days?: number;
            notes?: string;
            includedInTotal?: boolean;
        },
    ) {
        return prisma.$transaction(async (tx) => {
            const existing = await tx.proposalService.findFirst({
                where: { id: serviceId, proposalId },
            });
            if (!existing) return null;

            const service = await tx.proposalService.update({
                where: { id: serviceId },
                data: {
                    ...(serviceData.serviceName !== undefined && { serviceName: serviceData.serviceName }),
                    ...(serviceData.dateFrom !== undefined && {
                        dateFrom: serviceData.dateFrom ? new Date(serviceData.dateFrom) : null,
                    }),
                    ...(serviceData.dateTo !== undefined && {
                        dateTo: serviceData.dateTo ? new Date(serviceData.dateTo) : null,
                    }),
                    ...(serviceData.buyPrice !== undefined && {
                        buyPrice: new Decimal(serviceData.buyPrice).toFixed(2),
                    }),
                    ...(serviceData.sellPrice !== undefined && {
                        sellPrice: new Decimal(serviceData.sellPrice).toFixed(2),
                    }),
                    ...(serviceData.quantity !== undefined && { quantity: serviceData.quantity }),
                    ...(serviceData.days !== undefined && { days: serviceData.days }),
                    ...(serviceData.notes !== undefined && { notes: serviceData.notes }),
                    ...(serviceData.includedInTotal !== undefined && { includedInTotal: serviceData.includedInTotal }),
                },
            });

            const proposal = await tx.proposal.findUnique({ where: { id: proposalId }, select: { markupSettings: true } });
            const { totalBuy, totalSell } = await recalcTotals(tx, proposalId, proposal?.markupSettings);

            const updatedProposal = await tx.proposal.update({
                where: { id: proposalId },
                data: { totalBuy: totalBuy.toFixed(2), totalSell: totalSell.toFixed(2) },
            });

            return { service, proposal: updatedProposal };
        });
    }

    /**
     * Deletes a service and recalculates totals atomically.
     */
    async removeServiceTx(proposalId: string, serviceId: string) {
        return prisma.$transaction(async (tx) => {
            const existing = await tx.proposalService.findFirst({
                where: { id: serviceId, proposalId },
            });
            if (!existing) return null;

            await tx.proposalService.delete({ where: { id: serviceId } });

            const proposal = await tx.proposal.findUnique({ where: { id: proposalId }, select: { markupSettings: true } });
            const { totalBuy, totalSell } = await recalcTotals(tx, proposalId, proposal?.markupSettings);

            const updatedProposal = await tx.proposal.update({
                where: { id: proposalId },
                data: { totalBuy: totalBuy.toFixed(2), totalSell: totalSell.toFixed(2) },
            });

            return { proposal: updatedProposal };
        });
    }

    async adjustHotelPricing(
        proposalId: string,
        hotelId: string,
        data: { rooms?: any; totalPrice?: number; currency?: string },
    ) {
        return prisma.$transaction(async (tx) => {
            const hotel = await tx.proposalHotel.update({
                where: { id: hotelId },
                data: {
                    ...(data.rooms !== undefined && { rooms: data.rooms }),
                    ...(data.totalPrice !== undefined && { totalPrice: new Decimal(data.totalPrice).toFixed(2) }),
                    ...(data.currency !== undefined && { currency: data.currency }),
                },
            });

            const proposal = await tx.proposal.findUnique({ where: { id: proposalId }, select: { markupSettings: true } });
            const { totalBuy, totalSell } = await recalcTotals(tx, proposalId, proposal?.markupSettings);

            const updatedProposal = await tx.proposal.update({
                where: { id: proposalId },
                data: { totalBuy: totalBuy.toFixed(2), totalSell: totalSell.toFixed(2) },
            });

            return { hotel, proposal: updatedProposal };
        });
    }

    /**
     * Toggle whether a hotel is included in the proposal grand total.
     * Used for Oliver's "options" feature where multiple hotels can be offered
     * but only checked ones contribute to the customer-facing total.
     */
    async toggleHotelIncluded(proposalId: string, hotelId: string, includedInTotal: boolean) {
        return prisma.$transaction(async (tx) => {
            const hotel = await tx.proposalHotel.update({
                where: { id: hotelId },
                data: { includedInTotal },
            });

            const proposal = await tx.proposal.findUnique({
                where: { id: proposalId },
                select: { markupSettings: true },
            });
            const { totalBuy, totalSell } = await recalcTotals(tx, proposalId, proposal?.markupSettings);

            const updatedProposal = await tx.proposal.update({
                where: { id: proposalId },
                data: { totalBuy: totalBuy.toFixed(2), totalSell: totalSell.toFixed(2) },
            });

            return { hotel, proposal: updatedProposal };
        });
    }

    /**
     * Atomically acquires a lock on a proposal.
     * Uses updateMany with a conditional WHERE to prevent lost-update races.
     * Returns null if the lock could not be acquired (i.e. already locked by another user).
     */
    async acquireLock(proposalId: string, userId: string): Promise<any | null> {
        const lockExpiry = new Date(Date.now() - LOCK_TIMEOUT_MINUTES * 60 * 1000);

        const updated = await prisma.proposal.updateMany({
            where: {
                id: proposalId,
                OR: [{ lockedBy: null }, { lockedAt: { lt: lockExpiry } }, { lockedBy: userId }],
            },
            data: { lockedBy: userId, lockedAt: new Date() },
        });

        if (updated.count === 0) return null; // Lock held by someone else

        return prisma.proposal.findUnique({ where: { id: proposalId } });
    }

    /**
     * Releases the lock on a proposal. Only the lock owner can unlock.
     */
    async releaseLock(proposalId: string, userId: string) {
        return prisma.proposal.updateMany({
            where: { id: proposalId, lockedBy: userId },
            data: { lockedBy: null, lockedAt: null },
        });
    }

    async setDraft(id: string) {
        return prisma.proposal.update({
            where: { id },
            data: { status: ProposalStatus.draft },
        });
    }

    async setSent(
        id: string,
        sentBy: string,
        sentToEmail?: string,
    ) {
        return prisma.proposal.update({
            where: { id },
            data: {
                status: ProposalStatus.sent,
                sentAt: new Date(),
                sentBy,
                sentToEmail: sentToEmail ?? null,
                lockedBy: null,
                lockedAt: null,
            },
        });
    }

    async setPendingAdminApproval(id: string) {
        return prisma.proposal.update({
            where: { id },
            data: {
                status: ProposalStatus.pending_admin_approval,
                lockedBy: null,
                lockedAt: null,
            },
        });
    }

    async setApproved(id: string, approvedBy: string, pdfUrl?: string) {
        return prisma.proposal.update({
            where: { id },
            data: {
                status: ProposalStatus.approved,
                approvedAt: new Date(),
                approvedBy,
                pdfUrl: pdfUrl ?? null,
                rejectedAt: null,
                rejectedBy: null,
                rejectionReason: null,
                lockedBy: null,
                lockedAt: null,
            },
        });
    }

    async setDeclined(id: string, rejectedBy: string, rejectionReason: string) {
        return prisma.proposal.update({
            where: { id },
            data: {
                status: ProposalStatus.declined,
                rejectedAt: new Date(),
                rejectedBy,
                rejectionReason,
                approvedAt: null,
                approvedBy: null,
                pdfUrl: null,
                lockedBy: null,
                lockedAt: null,
            },
        });
    }

    async addHotel(proposalId: string, hotelData: any) {
        return prisma.proposalHotel.create({
            data: { ...hotelData, proposalId },
        });
    }

    async addService(proposalId: string, serviceData: any) {
        return prisma.proposalService.create({
            data: { ...serviceData, proposalId },
        });
    }

    // ─── Proposal Offer History ─────────────────────────────────────────

    /** Count how many offers have been sent for this proposal. */
    async countOffers(proposalId: string): Promise<number> {
        return prisma.proposalOffer.count({ where: { proposalId } });
    }

    /** Create a new ProposalOffer history row. */
    async createOffer(data: {
        proposalId: string;
        offerNumber: number;
        type: string;
        pdfKey: string;
        pdfUrl: string;
        sentBy: string;
        sentToEmails: string[];
        hotelSnapshot?: any;
        serviceSnapshot?: any;
        totalPrice?: number | null;
        currency?: string | null;
        method?: string | null;
    }) {
        return prisma.proposalOffer.create({
            data: {
                proposalId: data.proposalId,
                offerNumber: data.offerNumber,
                type: data.type,
                pdfKey: data.pdfKey,
                pdfUrl: data.pdfUrl,
                sentBy: data.sentBy,
                sentToEmails: data.sentToEmails,
                hotelSnapshot: data.hotelSnapshot ?? null,
                serviceSnapshot: data.serviceSnapshot ?? null,
                totalPrice: data.totalPrice ?? null,
                currency: data.currency ?? null,
                method: data.method ?? null,
            },
        });
    }

    /** List all offers for a proposal (oldest first by offerNumber). */
    async listOffers(proposalId: string) {
        return prisma.proposalOffer.findMany({
            where: { proposalId },
            orderBy: { offerNumber: 'asc' },
        });
    }

    /** Fetch a single offer by id. */
    async getOfferById(offerId: string) {
        return prisma.proposalOffer.findUnique({ where: { id: offerId } });
    }
}

export default new ProposalRepository();

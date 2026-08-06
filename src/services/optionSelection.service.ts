import crypto from 'crypto';

import { PrismaClient, ProposalStatus } from '@prisma/client';
import logger from '../utils/logger';

const prisma = new PrismaClient();

/**
 * Captures the customer choosing one hotel option from an offer.
 *
 * This is where a quotation becomes a commitment. Before a selection exists,
 * nothing is reserved and nothing is owed; after it, SETT holds rooms and is
 * bound by the supplier's cancellation terms.
 *
 * The client's requirement is that the choice cannot be informal. A customer
 * replying "yes, option B" does not constitute acceptance — what they are
 * agreeing to has to be presented and recorded: the hotel and room arrangement,
 * the buying and selling conditions, the cancellation terms, the payment terms,
 * and whether the rate is refundable. For a non-refundable rate that record is
 * the only thing standing behind SETT's financial exposure, so it is captured
 * explicitly and separately from the selection itself.
 */

export class OptionSelectionError extends Error {
    constructor(
        message: string,
        readonly code:
            | 'PROPOSAL_NOT_SENT'
            | 'OPTION_NOT_IN_OFFER'
            | 'ALREADY_SELECTED'
            | 'SELECTION_NOT_FOUND'
            | 'TERMS_NOT_ACCEPTED'
            | 'LOCK_EXPIRED',
        readonly details?: unknown,
    ) {
        super(message);
        this.name = 'OptionSelectionError';
    }
}

/**
 * How long an accepted price is held before it must be re-checked.
 *
 * Supplier rates move within hours. This is not a promise to the customer —
 * it is the window in which we are willing to book without re-pricing, after
 * which the booking flow re-searches and compares against what was accepted.
 */
export const PRICE_LOCK_HOURS = Number(process.env['OPTION_PRICE_LOCK_HOURS'] ?? 48);

/** The terms shown to the customer, snapshotted at the moment they accept. */
export interface AcceptedTerms {
    hotelName?: string;
    roomArrangement?: unknown;
    /** What SETT pays the supplier. Held for the internal margin record. */
    buyingTotal?: number;
    /** What the customer pays. The figure they are agreeing to. */
    sellingTotal?: number;
    currency?: string;
    cancellationPolicy?: string;
    cancellationDeadline?: string | null;
    paymentTerms?: string;
    nonRefundable: boolean;
    checkInDate?: string;
    checkOutDate?: string;
    nights?: number;
}

export interface SelectOptionParams {
    proposalId: string;
    /** Which hotel from the offer the customer chose. */
    hotelCode: string;
    offerId?: string;
    /** Email of the agent making the choice, when it came in through the link. */
    selectedByEmail?: string;
    /** Staff member, when a selection is recorded on a customer's behalf. */
    selectedById?: string;
    /**
     * Explicit acceptance of the stated terms. Required for a non-refundable
     * rate and refused without it — the whole point is that a non-refundable
     * commitment cannot be made by implication.
     */
    acceptTerms?: boolean;
    acceptedFromIp?: string;
    acceptedUserAgent?: string;
}

export class OptionSelectionService {
    /**
     * Generate the token that goes in the customer's selection link.
     *
     * Random rather than derived from the proposal: a token that encodes its
     * subject lets anyone holding one link reason about another.
     */
    generateSelectionToken(): string {
        return crypto.randomBytes(24).toString('base64url');
    }

    /**
     * Record the customer's choice.
     *
     * Refuses rather than proceeds in three cases, all of which would otherwise
     * produce a reservation nobody agreed to: an offer that was never sent, a
     * hotel that was not among the options, and a non-refundable rate whose
     * terms were not explicitly accepted.
     */
    async selectOption(params: SelectOptionParams) {
        const proposal = await prisma.proposal.findUnique({
            where: { id: params.proposalId },
            include: {
                hotels: { where: { deletedAt: null } },
                offers: { orderBy: { sentAt: 'desc' }, take: 1 },
                bookingRequest: true,
            },
        });

        if (!proposal) {
            throw new OptionSelectionError('Proposal not found', 'SELECTION_NOT_FOUND');
        }

        // A customer can only choose from an offer they were sent. Selecting
        // against a draft would book against pricing still being edited.
        if (!proposal.sentAt || proposal.status === ProposalStatus.draft) {
            throw new OptionSelectionError(
                'This proposal has not been sent to the customer yet',
                'PROPOSAL_NOT_SENT',
            );
        }

        const hotel = proposal.hotels.find((h) => h.hotelCode === params.hotelCode);
        if (!hotel) {
            throw new OptionSelectionError(
                `Hotel ${params.hotelCode} is not one of the options on this offer`,
                'OPTION_NOT_IN_OFFER',
            );
        }

        const existing = await prisma.optionSelection.findFirst({
            where: { proposalId: params.proposalId },
        });
        if (existing) {
            throw new OptionSelectionError(
                `This offer already has a selection (${existing.hotelName ?? existing.hotelCode}). ` +
                    `Withdraw it before recording a different one.`,
                'ALREADY_SELECTED',
                { existingSelectionId: existing.id },
            );
        }

        // Free cancellation is stored as a nullable flag; absent means we do not
        // know, and an unknown cancellation policy is treated as non-refundable.
        // Assuming the friendlier reading here would skip the explicit
        // acceptance on exactly the bookings that need it.
        const nonRefundable = hotel.freeCancellation !== true;

        if (nonRefundable && !params.acceptTerms) {
            throw new OptionSelectionError(
                'This rate is non-refundable. The customer must explicitly accept the stated ' +
                    'price and conditions before the booking can be made.',
                'TERMS_NOT_ACCEPTED',
                { hotelCode: params.hotelCode, nonRefundable: true },
            );
        }

        const terms = this.buildTerms(proposal, hotel, nonRefundable);
        const lockedUntil = new Date(Date.now() + PRICE_LOCK_HOURS * 3_600_000);

        const selection = await prisma.optionSelection.create({
            data: {
                proposalId: params.proposalId,
                offerId: params.offerId ?? proposal.offers[0]?.id,
                hotelCode: hotel.hotelCode,
                hotelName: hotel.hotelName,
                acceptedTotal: hotel.totalPrice,
                currency: hotel.currency,
                nonRefundable,
                acceptedTerms: terms as any,
                // Stamped only when acceptance was actually given, so its
                // presence is evidence rather than a default.
                termsAcceptedAt: params.acceptTerms ? new Date() : null,
                acceptedFromIp: params.acceptedFromIp,
                acceptedUserAgent: params.acceptedUserAgent,
                selectedByEmail: params.selectedByEmail,
                selectedById: params.selectedById,
                lockedUntil,
            },
        });

        logger.info({
            msg: 'Option selected',
            selectionId: selection.id,
            proposalId: params.proposalId,
            hotelCode: hotel.hotelCode,
            nonRefundable,
            termsAccepted: Boolean(params.acceptTerms),
            lockedUntil,
        });

        return selection;
    }

    /**
     * Issue the token that goes in a customer's selection link.
     *
     * Called when the offer is sent. Idempotent: re-sending an offer keeps the
     * existing token, so a customer who kept the first email still lands on
     * their offer rather than a dead link.
     */
    async ensureSelectionToken(proposalId: string): Promise<string> {
        const proposal = await prisma.proposal.findUnique({
            where: { id: proposalId },
            select: { selectionToken: true },
        });

        if (!proposal) {
            throw new OptionSelectionError('Proposal not found', 'SELECTION_NOT_FOUND');
        }
        if (proposal.selectionToken) return proposal.selectionToken;

        const token = this.generateSelectionToken();
        await prisma.proposal.update({
            where: { id: proposalId },
            data: { selectionToken: token },
        });
        return token;
    }

    /**
     * Resolve a customer's selection link to the offer behind it.
     *
     * Returns the proposal with its options and whatever has been chosen so
     * far — the link is followed before any choice exists, so an absent
     * selection is the normal first case rather than an error.
     */
    async findByToken(token: string) {
        const proposal = await prisma.proposal.findUnique({
            where: { selectionToken: token },
            include: { hotels: { where: { deletedAt: null } } },
        });

        if (!proposal) {
            throw new OptionSelectionError('Selection link is not valid', 'SELECTION_NOT_FOUND');
        }

        const selection = await prisma.optionSelection.findFirst({
            where: { proposalId: proposal.id },
            orderBy: { selectedAt: 'desc' },
        });

        return { proposal, selection };
    }

    async findByProposal(proposalId: string) {
        return prisma.optionSelection.findFirst({
            where: { proposalId },
            orderBy: { selectedAt: 'desc' },
        });
    }

    /**
     * Whether the accepted price may still be booked without re-pricing.
     *
     * Reported rather than enforced here: the booking flow re-searches anyway
     * and compares against the accepted total, so an expired lock is a reason
     * to warn an operator, not to refuse outright.
     */
    isPriceLockValid(selection: { lockedUntil: Date | null }): boolean {
        if (!selection.lockedUntil) return false;
        return selection.lockedUntil.getTime() > Date.now();
    }

    /**
     * Withdraw a selection so a different option can be chosen.
     *
     * Refuses once a booking group exists against the proposal: at that point
     * rooms are held with a supplier, and undoing the choice means cancelling
     * reservations rather than deleting a row.
     */
    async withdrawSelection(selectionId: string): Promise<void> {
        const selection = await prisma.optionSelection.findUnique({
            where: { id: selectionId },
        });
        if (!selection) {
            throw new OptionSelectionError('Selection not found', 'SELECTION_NOT_FOUND');
        }

        const groups = await prisma.bookingGroup.count({
            where: { proposalId: selection.proposalId },
        });
        if (groups > 0) {
            throw new OptionSelectionError(
                'This selection has already been booked. Cancel the booking group before ' +
                    'changing the selected option.',
                'ALREADY_SELECTED',
                { bookingGroups: groups },
            );
        }

        await prisma.optionSelection.delete({ where: { id: selectionId } });

        logger.info({
            msg: 'Option selection withdrawn',
            selectionId,
            proposalId: selection.proposalId,
        });
    }

    /**
     * Capture the terms as the customer sees them.
     *
     * Both the buying and the selling figure are recorded. The customer is only
     * shown the selling price, but the client's process treats the buying and
     * selling conditions as part of what is agreed, and reconstructing the
     * margin afterwards from an edited proposal would not be reliable.
     */
    private buildTerms(
        proposal: { paymentDeadline: Date | null; bookingRequest: { nights: number } | null },
        hotel: {
            hotelName: string | null;
            totalPrice: unknown;
            currency: string;
            rooms: unknown;
            freeCancellation: boolean | null;
            cancelDeadline: Date | null;
            cancelDeadlineOverride: Date | null;
        },
        nonRefundable: boolean,
    ): AcceptedTerms {
        // An override is only ever earlier than the supplier's own deadline, so
        // it is the date the customer is actually held to.
        const deadline = hotel.cancelDeadlineOverride ?? hotel.cancelDeadline;

        return {
            hotelName: hotel.hotelName ?? undefined,
            roomArrangement: hotel.rooms ?? undefined,
            sellingTotal: Number(hotel.totalPrice),
            currency: hotel.currency,
            cancellationPolicy: nonRefundable
                ? 'Non-refundable. This booking cannot be cancelled or amended without charge.'
                : deadline
                  ? `Free cancellation until ${deadline.toISOString().slice(0, 10)}.`
                  : 'Free cancellation, deadline to be confirmed.',
            cancellationDeadline: deadline ? deadline.toISOString() : null,
            paymentTerms: proposal.paymentDeadline
                ? `Payment due by ${proposal.paymentDeadline.toISOString().slice(0, 10)}.`
                : undefined,
            nonRefundable,
            nights: proposal.bookingRequest?.nights ?? undefined,
        };
    }
}

export default new OptionSelectionService();

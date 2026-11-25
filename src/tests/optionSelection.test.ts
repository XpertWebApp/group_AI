/**
 * Unit tests for option selection.
 *
 * This is the point a quotation becomes a commitment, so the guards here are
 * the ones that stop a reservation nobody agreed to: selecting against an
 * unsent proposal, selecting a hotel that was never offered, selecting twice,
 * and — the one the client was explicit about — committing to a non-refundable
 * rate without the customer having accepted its terms.
 */
jest.mock('@prisma/client', () => {
    const mPrisma = {
        proposal: { findUnique: jest.fn(), update: jest.fn() },
        optionSelection: {
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            create: jest.fn(),
            delete: jest.fn(),
        },
        bookingGroup: { count: jest.fn() },
    };
    return {
        PrismaClient: jest.fn(() => mPrisma),
        Prisma: { DbNull: null, JsonNull: null },
        ProposalStatus: {
            draft: 'draft',
            pending_admin_approval: 'pending_admin_approval',
            sent: 'sent',
            approved: 'approved',
            declined: 'declined',
        },
    };
});

import { PrismaClient, ProposalStatus } from '@prisma/client';
import service, {
    OptionSelectionError,
    PRICE_LOCK_HOURS,
} from '../services/optionSelection.service';

const prisma = new (PrismaClient as any)() as any;

// ── Fixtures ────────────────────────────────────────────────────────────────

const HOTEL_CODE = 'HOTEL-1';
const PROPOSAL_ID = '11111111-2222-4333-8444-555555555555';

const aHotel = (over: Record<string, unknown> = {}) => ({
    hotelCode: HOTEL_CODE,
    hotelName: 'Test Hotel',
    totalPrice: 1500,
    currency: 'EUR',
    rooms: { standard: { qty: 5 } },
    freeCancellation: true,
    cancelDeadline: new Date('2026-09-01'),
    cancelDeadlineOverride: null,
    deletedAt: null,
    ...over,
});

const aProposal = (over: Record<string, unknown> = {}) => ({
    id: PROPOSAL_ID,
    status: ProposalStatus.sent,
    sentAt: new Date('2026-08-01'),
    paymentDeadline: new Date('2026-08-20'),
    hotels: [aHotel()],
    offers: [{ id: 'offer-1' }],
    bookingRequest: { nights: 3 },
    ...over,
});

/** Echo the created row back, the way Prisma does. */
const echoCreate = () =>
    prisma.optionSelection.create.mockImplementation(async ({ data }: any) => ({
        id: 'selection-1',
        ...data,
    }));

/**
 * Read the snapshotted terms. Prisma types a Json column as the whole JSON
 * union, so the assertions need the shape the service actually writes.
 */
const terms = (selection: any): Record<string, any> => selection.acceptedTerms;

beforeEach(() => {
    jest.clearAllMocks();
    prisma.proposal.findUnique.mockResolvedValue(aProposal());
    prisma.optionSelection.findFirst.mockResolvedValue(null);
    prisma.bookingGroup.count.mockResolvedValue(0);
    echoCreate();
});

describe('Option selection', () => {
    // ────────────────────────────────────────────────────────────────────────
    describe('selection tokens', () => {
        it('produces a token long enough not to be guessed', () => {
            expect(service.generateSelectionToken().length).toBeGreaterThanOrEqual(32);
        });

        it('produces a different token every time', () => {
            const tokens = new Set(
                Array.from({ length: 200 }, () => service.generateSelectionToken()),
            );
            expect(tokens.size).toBe(200);
        });

        it('produces a URL-safe token', () => {
            // It travels in a link; padding or slashes would need escaping and
            // would break on the copy-paste route customers actually use.
            expect(service.generateSelectionToken()).toMatch(/^[A-Za-z0-9_-]+$/);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('issuing the link token', () => {
        it('issues a token when the proposal has none', async () => {
            prisma.proposal.findUnique.mockResolvedValue({ selectionToken: null });
            prisma.proposal.update.mockResolvedValue({});

            const token = await service.ensureSelectionToken(PROPOSAL_ID);
            expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
            expect(prisma.proposal.update).toHaveBeenCalled();
        });

        it('keeps the existing token when the offer is re-sent', async () => {
            // A new token on every send would kill the link in the first email,
            // which is the one a customer is most likely to still have.
            prisma.proposal.findUnique.mockResolvedValue({ selectionToken: 'existing-token' });

            const token = await service.ensureSelectionToken(PROPOSAL_ID);
            expect(token).toBe('existing-token');
            expect(prisma.proposal.update).not.toHaveBeenCalled();
        });

        it('refuses to issue a token for a proposal that does not exist', async () => {
            prisma.proposal.findUnique.mockResolvedValue(null);

            await expect(service.ensureSelectionToken(PROPOSAL_ID)).rejects.toMatchObject({
                code: 'SELECTION_NOT_FOUND',
            });
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('following the customer link', () => {
        it('returns the options before anything has been chosen', async () => {
            // The link is sent before a choice exists, so this is the normal
            // first visit — not an error.
            prisma.proposal.findUnique.mockResolvedValue(aProposal());
            prisma.optionSelection.findFirst.mockResolvedValue(null);

            const { proposal, selection } = await service.findByToken('some-token');
            expect((proposal as any).hotels).toHaveLength(1);
            expect(selection).toBeNull();
        });

        it('returns the choice once one has been made', async () => {
            prisma.proposal.findUnique.mockResolvedValue(aProposal());
            prisma.optionSelection.findFirst.mockResolvedValue({
                id: 'selection-1',
                hotelCode: HOTEL_CODE,
            });

            const { selection } = await service.findByToken('some-token');
            expect(selection?.hotelCode).toBe(HOTEL_CODE);
        });

        it('refuses a token that resolves to nothing', async () => {
            prisma.proposal.findUnique.mockResolvedValue(null);

            await expect(service.findByToken('bad-token')).rejects.toMatchObject({
                code: 'SELECTION_NOT_FOUND',
            });
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('a refundable option', () => {
        it('records the selection', async () => {
            const sel = await service.selectOption({
                proposalId: PROPOSAL_ID,
                hotelCode: HOTEL_CODE,
            });
            expect(sel.hotelCode).toBe(HOTEL_CODE);
        });

        it('does not require explicit acceptance', async () => {
            // The selection itself is the agreement when the rate can be
            // cancelled; the extra step exists for money at risk.
            await expect(
                service.selectOption({ proposalId: PROPOSAL_ID, hotelCode: HOTEL_CODE }),
            ).resolves.toBeDefined();
        });

        it('stores the price the customer accepted', async () => {
            const sel = await service.selectOption({
                proposalId: PROPOSAL_ID,
                hotelCode: HOTEL_CODE,
            });
            expect(sel.acceptedTotal).toBe(1500);
            expect(sel.currency).toBe('EUR');
        });

        it('marks it refundable', async () => {
            const sel = await service.selectOption({
                proposalId: PROPOSAL_ID,
                hotelCode: HOTEL_CODE,
            });
            expect(sel.nonRefundable).toBe(false);
        });

        it('leaves the acceptance timestamp unset when none was given', async () => {
            // Its presence has to mean something, so it is not stamped by default.
            const sel = await service.selectOption({
                proposalId: PROPOSAL_ID,
                hotelCode: HOTEL_CODE,
            });
            expect(sel.termsAcceptedAt).toBeNull();
        });

        it('records the cancellation deadline in the accepted terms', async () => {
            const sel = await service.selectOption({
                proposalId: PROPOSAL_ID,
                hotelCode: HOTEL_CODE,
            });
            expect(terms(sel).cancellationPolicy).toMatch(/Free cancellation until/);
            expect(terms(sel).cancellationDeadline).toBeTruthy();
        });

        it('prefers an operator-set deadline over the supplier one', async () => {
            // An override is only ever earlier, so it is the date the customer
            // is actually held to.
            prisma.proposal.findUnique.mockResolvedValue(
                aProposal({
                    hotels: [
                        aHotel({
                            cancelDeadline: new Date('2026-09-01'),
                            cancelDeadlineOverride: new Date('2026-08-25'),
                        }),
                    ],
                }),
            );

            const sel = await service.selectOption({
                proposalId: PROPOSAL_ID,
                hotelCode: HOTEL_CODE,
            });
            expect(terms(sel).cancellationDeadline).toContain('2026-08-25');
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('a non-refundable option', () => {
        beforeEach(() => {
            prisma.proposal.findUnique.mockResolvedValue(
                aProposal({ hotels: [aHotel({ freeCancellation: false })] }),
            );
        });

        it('refuses a selection with no explicit acceptance', async () => {
            // The client's requirement: a non-refundable commitment cannot be
            // made by implication.
            await expect(
                service.selectOption({ proposalId: PROPOSAL_ID, hotelCode: HOTEL_CODE }),
            ).rejects.toThrow(OptionSelectionError);
        });

        it('reports why it refused', async () => {
            await expect(
                service.selectOption({ proposalId: PROPOSAL_ID, hotelCode: HOTEL_CODE }),
            ).rejects.toMatchObject({ code: 'TERMS_NOT_ACCEPTED' });
        });

        it('creates nothing when acceptance is missing', async () => {
            await service
                .selectOption({ proposalId: PROPOSAL_ID, hotelCode: HOTEL_CODE })
                .catch(() => undefined);
            expect(prisma.optionSelection.create).not.toHaveBeenCalled();
        });

        it('records the selection once the terms are accepted', async () => {
            const sel = await service.selectOption({
                proposalId: PROPOSAL_ID,
                hotelCode: HOTEL_CODE,
                acceptTerms: true,
            });
            expect(sel.nonRefundable).toBe(true);
        });

        it('stamps when the acceptance was given', async () => {
            const sel = await service.selectOption({
                proposalId: PROPOSAL_ID,
                hotelCode: HOTEL_CODE,
                acceptTerms: true,
            });
            expect(sel.termsAcceptedAt).toBeInstanceOf(Date);
        });

        it('keeps the address and agent the acceptance came from', async () => {
            // A disputed acceptance is defended with evidence, not a boolean.
            const sel = await service.selectOption({
                proposalId: PROPOSAL_ID,
                hotelCode: HOTEL_CODE,
                acceptTerms: true,
                acceptedFromIp: '203.0.113.7',
                acceptedUserAgent: 'Mozilla/5.0',
            });
            expect(sel.acceptedFromIp).toBe('203.0.113.7');
            expect(sel.acceptedUserAgent).toBe('Mozilla/5.0');
        });

        it('states plainly in the terms that it cannot be cancelled', async () => {
            const sel = await service.selectOption({
                proposalId: PROPOSAL_ID,
                hotelCode: HOTEL_CODE,
                acceptTerms: true,
            });
            expect(terms(sel).cancellationPolicy).toMatch(/Non-refundable/);
            expect(terms(sel).nonRefundable).toBe(true);
        });

        it('treats an unknown cancellation policy as non-refundable', async () => {
            // freeCancellation is nullable. Reading absent as "refundable"
            // would skip the acceptance step on exactly the bookings that need
            // it, so the cautious reading wins.
            prisma.proposal.findUnique.mockResolvedValue(
                aProposal({ hotels: [aHotel({ freeCancellation: null })] }),
            );

            await expect(
                service.selectOption({ proposalId: PROPOSAL_ID, hotelCode: HOTEL_CODE }),
            ).rejects.toMatchObject({ code: 'TERMS_NOT_ACCEPTED' });
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('selections that must be refused', () => {
        it('refuses a proposal that does not exist', async () => {
            prisma.proposal.findUnique.mockResolvedValue(null);

            await expect(
                service.selectOption({ proposalId: PROPOSAL_ID, hotelCode: HOTEL_CODE }),
            ).rejects.toMatchObject({ code: 'SELECTION_NOT_FOUND' });
        });

        it('refuses a proposal that was never sent', async () => {
            // Selecting against a draft books pricing still being edited.
            prisma.proposal.findUnique.mockResolvedValue(
                aProposal({ sentAt: null, status: ProposalStatus.draft }),
            );

            await expect(
                service.selectOption({ proposalId: PROPOSAL_ID, hotelCode: HOTEL_CODE }),
            ).rejects.toMatchObject({ code: 'PROPOSAL_NOT_SENT' });
        });

        it('refuses a hotel that was not among the options', async () => {
            await expect(
                service.selectOption({ proposalId: PROPOSAL_ID, hotelCode: 'NOT-OFFERED' }),
            ).rejects.toMatchObject({ code: 'OPTION_NOT_IN_OFFER' });
        });

        it('refuses a second selection on the same offer', async () => {
            prisma.optionSelection.findFirst.mockResolvedValue({
                id: 'existing-1',
                hotelName: 'Already Chosen',
            });

            await expect(
                service.selectOption({ proposalId: PROPOSAL_ID, hotelCode: HOTEL_CODE }),
            ).rejects.toMatchObject({ code: 'ALREADY_SELECTED' });
        });

        it('names the existing selection so it can be withdrawn', async () => {
            prisma.optionSelection.findFirst.mockResolvedValue({
                id: 'existing-1',
                hotelName: 'Already Chosen',
            });

            await expect(
                service.selectOption({ proposalId: PROPOSAL_ID, hotelCode: HOTEL_CODE }),
            ).rejects.toMatchObject({ details: { existingSelectionId: 'existing-1' } });
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('price lock', () => {
        it('locks the accepted price for the configured window', async () => {
            const sel = await service.selectOption({
                proposalId: PROPOSAL_ID,
                hotelCode: HOTEL_CODE,
            });

            const hours = (sel.lockedUntil!.getTime() - Date.now()) / 3_600_000;
            expect(hours).toBeGreaterThan(PRICE_LOCK_HOURS - 1);
            expect(hours).toBeLessThanOrEqual(PRICE_LOCK_HOURS);
        });

        it('reports a future lock as valid', () => {
            expect(
                service.isPriceLockValid({ lockedUntil: new Date(Date.now() + 3_600_000) }),
            ).toBe(true);
        });

        it('reports a past lock as expired', () => {
            expect(
                service.isPriceLockValid({ lockedUntil: new Date(Date.now() - 3_600_000) }),
            ).toBe(false);
        });

        it('treats a missing lock as expired rather than eternal', () => {
            expect(service.isPriceLockValid({ lockedUntil: null })).toBe(false);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('withdrawing a selection', () => {
        it('removes a selection that was never booked', async () => {
            prisma.optionSelection.findUnique.mockResolvedValue({
                id: 'selection-1',
                proposalId: PROPOSAL_ID,
            });

            await service.withdrawSelection('selection-1');
            expect(prisma.optionSelection.delete).toHaveBeenCalled();
        });

        it('refuses to withdraw once rooms are held with a supplier', async () => {
            // Undoing the choice then means cancelling reservations, not
            // deleting a row.
            prisma.optionSelection.findUnique.mockResolvedValue({
                id: 'selection-1',
                proposalId: PROPOSAL_ID,
            });
            prisma.bookingGroup.count.mockResolvedValue(1);

            await expect(service.withdrawSelection('selection-1')).rejects.toMatchObject({
                code: 'ALREADY_SELECTED',
            });
            expect(prisma.optionSelection.delete).not.toHaveBeenCalled();
        });

        it('refuses to withdraw a selection that does not exist', async () => {
            prisma.optionSelection.findUnique.mockResolvedValue(null);

            await expect(service.withdrawSelection('missing')).rejects.toMatchObject({
                code: 'SELECTION_NOT_FOUND',
            });
        });
    });
});

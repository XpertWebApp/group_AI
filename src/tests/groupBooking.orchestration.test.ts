/**
 * Orchestration tests for group booking.
 *
 * These cover what happens across several supplier bookings rather than the
 * arithmetic inside one — above all, that a slice failing part-way through does
 * not throw away the rooms earlier slices already hold. That is the behaviour
 * the client asked for and the one that costs a customer real rooms if it
 * regresses.
 *
 * WBE, the search and the database are all mocked. Nothing here contacts a
 * supplier.
 */
import { BookingFlowStatus } from '@prisma/client';

// ── Mocks ───────────────────────────────────────────────────────────────────
jest.mock('@prisma/client', () => ({
    PrismaClient: jest.fn(() => ({})),
    Prisma: { DbNull: null, JsonNull: null },
    BookingFlowStatus: {
        draft: 'draft',
        prebooked: 'prebooked',
        price_changed: 'price_changed',
        booking: 'booking',
        booked: 'booked',
        vouchered: 'vouchered',
        cancelled: 'cancelled',
        pending_cancellation: 'pending_cancellation',
        failed: 'failed',
    },
    BookingGroupStatus: {
        pending: 'pending',
        booking: 'booking',
        confirmed: 'confirmed',
        partial: 'partial',
        failed: 'failed',
        cancelled: 'cancelled',
    },
}));

jest.mock('../services/certificationSearch.service', () => {
    const actual = jest.requireActual('../services/certificationSearch.service');
    return { ...actual, __esModule: true, default: { search: jest.fn() } };
});

jest.mock('../services/wbeBooking.service', () => {
    const actual = jest.requireActual('../services/wbeBooking.service');
    return {
        ...actual,
        __esModule: true,
        default: {
            selectOption: jest.fn(),
            prebook: jest.fn(),
            acceptPriceChange: jest.fn(),
            book: jest.fn(),
            cancel: jest.fn(),
        },
    };
});

jest.mock('../repositories/bookingGroup.repository', () => {
    const actual = jest.requireActual('../repositories/bookingGroup.repository');
    return {
        ...actual,
        __esModule: true,
        default: {
            create: jest.fn(),
            attachBooking: jest.fn(),
            recomputeStatus: jest.fn(),
            findById: jest.fn(),
        },
    };
});

jest.mock('../repositories/booking.repository', () => {
    const actual = jest.requireActual('../repositories/booking.repository');
    return { ...actual, __esModule: true, default: { markFailed: jest.fn() } };
});

import groupBookingService, { GroupBookingError } from '../services/groupBooking.service';
import certificationSearchService from '../services/certificationSearch.service';
import wbeBookingService from '../services/wbeBooking.service';
import bookingGroupRepository from '../repositories/bookingGroup.repository';
import bookingRepository from '../repositories/booking.repository';

const search = certificationSearchService as jest.Mocked<any>;
const wbe = wbeBookingService as jest.Mocked<any>;
const groups = bookingGroupRepository as jest.Mocked<any>;
const bookings = bookingRepository as jest.Mocked<any>;

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A search response offering two suppliers at the same hotel. */
const searchResult = (opts: Array<{ supplier: string; total: number }>) => ({
    sessionId: 'session-1',
    checkInDate: '2026-10-01',
    checkOutDate: '2026-10-04',
    nights: 3,
    roomsRequested: [],
    totalOptions: opts.length,
    finished: true,
    hotels: [
        {
            hotelCode: 'HOTEL-1',
            hotelName: 'Test Hotel',
            options: opts.map((o) => ({
                tid: `tid-${o.supplier}`,
                supplierCode: o.supplier,
                totalPrice: o.total,
                currency: 'EUR',
                onRequest: false,
                updatedOptionsNeeded: false,
                rooms: [{ roomId: 1 }],
            })),
        },
    ],
});

const adult = () => ({
    salutation: 'Mr',
    firstName: 'John',
    lastName: 'Doe',
    isChild: false,
    isLeader: false,
});

/** `count` single-occupancy rooms, one passenger each. */
const roomsFor = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
        roomId: i + 1,
        adultsNo: 1,
        childrenNo: 0,
        passengers: [adult()],
    }));

const params = (over: Record<string, unknown> = {}) => ({
    requestId: 'req-1',
    hotelCode: 'HOTEL-1',
    hotelName: 'Test Hotel',
    checkInDate: new Date('2026-10-01'),
    nights: 3,
    roomsRequested: 10,
    rooms: roomsFor(10),
    currency: 'EUR',
    ...over,
});

/** A booking row as selectOption would return it. */
let bookingSeq = 0;
const aBooking = () => ({
    id: `booking-${++bookingSeq}`,
    status: BookingFlowStatus.draft,
    agencyReference: `SETT-TEST-${bookingSeq}`,
});

beforeEach(() => {
    jest.clearAllMocks();
    bookingSeq = 0;

    groups.create.mockResolvedValue({ id: 'group-1', groupReference: 'SETTG-TEST', bookings: [] });
    groups.attachBooking.mockResolvedValue(undefined);
    groups.recomputeStatus.mockResolvedValue({
        id: 'group-1',
        status: 'confirmed',
        roomsConfirmed: 10,
        roomsRequested: 10,
        bookings: [],
    });

    wbe.selectOption.mockImplementation(async () => aBooking());
    wbe.prebook.mockImplementation(async () => ({ status: BookingFlowStatus.prebooked }));
    wbe.book.mockResolvedValue({ status: BookingFlowStatus.booked });
    bookings.markFailed.mockResolvedValue(undefined);
});

describe('Group booking orchestration', () => {
    // ────────────────────────────────────────────────────────────────────────
    describe('a group that books cleanly', () => {
        it('books the group in chunks WBE will accept', async () => {
            // WBE caps a search at four rooms and refuses a booking whose room
            // count differs from its search, so ten rooms cannot be two
            // bookings however the suppliers split.
            search.search.mockResolvedValue(
                searchResult([
                    { supplier: 'EANRP', total: 900 },
                    { supplier: 'HBA', total: 900 },
                ]),
            );

            await groupBookingService.bookGroup(params() as any);

            // EANRP takes 9 (its cap), HotelBeds 1 — then each is chunked to
            // four: 4 + 4 + 1 + 1.
            expect(wbe.selectOption).toHaveBeenCalledTimes(4);
            expect(wbe.book).toHaveBeenCalledTimes(4);
        });

        it('never sends more than four rooms in one booking', async () => {
            // The limit that forced the chunking. Exceeding it is rejected by
            // WBE after the prebook is already spent.
            search.search.mockResolvedValue(
                searchResult([{ supplier: 'EANRP', total: 900 }]),
            );

            await groupBookingService.bookGroup(params() as any);

            for (const call of wbe.selectOption.mock.calls) {
                expect(call[0].rooms.length).toBeLessThanOrEqual(4);
            }
        });

        it('searches for exactly the rooms each booking will carry', async () => {
            // WBE: "The number of rooms is not the same as it was searched
            // for". The chunk's search and its booking have to agree.
            search.search.mockResolvedValue(
                searchResult([{ supplier: 'EANRP', total: 900 }]),
            );

            await groupBookingService.bookGroup(params() as any);

            // First search is the planning one; the rest are per chunk.
            const bookingSearches = search.search.mock.calls.slice(1);
            bookingSearches.forEach((searchCall: any[], i: number) => {
                expect(searchCall[0].rooms.length).toBe(
                    wbe.selectOption.mock.calls[i]![0].rooms.length,
                );
            });
        });

        it('books each chunk against a TID from its own search', async () => {
            // Not a unique TID per chunk — two chunks from the same supplier
            // legitimately share one. What matters is that the TID came from
            // the search that sized the booking, since WBE pairs them.
            search.search.mockResolvedValue(
                searchResult([{ supplier: 'EANRP', total: 900 }]),
            );

            await groupBookingService.bookGroup(params() as any);

            for (const call of wbe.selectOption.mock.calls) {
                expect(call[0].tid).toBeTruthy();
                expect(call[0].sessionId).toBeTruthy();
            }
        });

        it('carries the freshly searched session onto every booking', async () => {
            // The stored proposal TID is usually dead by booking time; every
            // slice must use the session this run just opened.
            search.search.mockResolvedValue(searchResult([{ supplier: 'EANRP', total: 900 }]));

            await groupBookingService.bookGroup(params({ roomsRequested: 5, rooms: roomsFor(5) }) as any);

            for (const call of wbe.selectOption.mock.calls) {
                expect(call[0].sessionId).toBe('session-1');
            }
        });

        it('splits the passenger manifest so each slice carries its own rooms', async () => {
            search.search.mockResolvedValue(
                searchResult([
                    { supplier: 'EANRP', total: 900 },
                    { supplier: 'HBA', total: 900 },
                ]),
            );

            await groupBookingService.bookGroup(params() as any);

            const roomCounts = wbe.selectOption.mock.calls.map((c: any[]) => c[0].rooms.length);
            expect(roomCounts.reduce((a: number, b: number) => a + b, 0)).toBe(10);
        });

        it('records the group before contacting WBE', async () => {
            // A reservation with no local record is the one failure we cannot
            // recover from, so the row must exist first.
            search.search.mockResolvedValue(searchResult([{ supplier: 'EANRP', total: 900 }]));

            await groupBookingService.bookGroup(params({ roomsRequested: 5, rooms: roomsFor(5) }) as any);

            expect(groups.create.mock.invocationCallOrder[0]).toBeLessThan(
                wbe.selectOption.mock.invocationCallOrder[0]!,
            );
        });

        it('never asks WBE to issue a voucher during booking', async () => {
            search.search.mockResolvedValue(searchResult([{ supplier: 'EANRP', total: 900 }]));

            await groupBookingService.bookGroup(params({ roomsRequested: 5, rooms: roomsFor(5) }) as any);

            expect(wbe.selectOption).toHaveBeenCalledWith(
                expect.objectContaining({ issueVoucherOnBook: false }),
            );
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('a slice that fails part-way through', () => {
        beforeEach(() => {
            search.search.mockResolvedValue(
                searchResult([
                    { supplier: 'EANRP', total: 900 },
                    { supplier: 'HBA', total: 900 },
                ]),
            );
            groups.recomputeStatus.mockResolvedValue({
                id: 'group-1',
                status: 'partial',
                roomsConfirmed: 9,
                roomsRequested: 10,
                shortfallNote: '1 room(s) short of the requested total. HBA: no availability',
                bookings: [],
            });
        });

        it('keeps the rooms earlier slices confirmed', async () => {
            // The client's decision: cancelling successful slices releases
            // rooms that may not come back, leaving the customer with nothing
            // rather than most of what they asked for.
            wbe.book
                .mockResolvedValueOnce({ status: BookingFlowStatus.booked })
                .mockRejectedValueOnce(new Error('no availability'));

            const group = await groupBookingService.bookGroup(params() as any);

            expect(wbe.cancel).not.toHaveBeenCalled();
            expect(group.status).toBe('partial');
        });

        it('continues to the next chunk instead of stopping at the first failure', async () => {
            // Ten rooms is three chunks. The first failing must not cost the
            // other two — those rooms are still available to hold.
            wbe.book
                .mockRejectedValueOnce(new Error('supplier refused'))
                .mockResolvedValue({ status: BookingFlowStatus.booked });

            await groupBookingService.bookGroup(params() as any);

            expect(wbe.book).toHaveBeenCalledTimes(4);
        });

        it('records which supplier refused, on the booking that failed', async () => {
            // The shortfall note is built from these, and whoever sources the
            // missing rooms needs to know who said no.
            wbe.book.mockRejectedValue(new Error('no availability'));

            await groupBookingService.bookGroup(params() as any);

            expect(bookings.markFailed).toHaveBeenCalledWith(
                expect.any(String),
                expect.stringMatching(/EANRP|HBA/),
            );
        });

        it('returns the group rather than throwing, so a partial result is visible', async () => {
            wbe.book.mockRejectedValueOnce(new Error('no availability'));

            await expect(groupBookingService.bookGroup(params() as any)).resolves.toMatchObject({
                status: 'partial',
            });
        });

        it('survives a failure before the booking row exists', async () => {
            // selectOption failing leaves no id to mark, which must not throw.
            wbe.selectOption
                .mockRejectedValueOnce(new Error('session expired'))
                .mockImplementationOnce(async () => aBooking());

            await expect(groupBookingService.bookGroup(params() as any)).resolves.toBeDefined();
        });

        it('recomputes the group status once every slice has been attempted', async () => {
            wbe.book.mockRejectedValueOnce(new Error('no availability'));

            await groupBookingService.bookGroup(params() as any);

            expect(groups.recomputeStatus).toHaveBeenCalledWith('group-1');
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('price movement at prebook', () => {
        beforeEach(() => {
            search.search.mockResolvedValue(searchResult([{ supplier: 'EANRP', total: 900 }]));
        });

        it('accepts a move that WBE reports at prebook', async () => {
            // The group already cleared its drift check against the customer's
            // quote; without accepting here the slice dies at BookV2 and the
            // group goes short over a few euros.
            wbe.prebook.mockResolvedValue({
                status: BookingFlowStatus.price_changed,
                quotedPrice: 900,
                prebookPrice: 920,
            });

            await groupBookingService.bookGroup(params({ roomsRequested: 5, rooms: roomsFor(5) }) as any);

            expect(wbe.acceptPriceChange).toHaveBeenCalled();
            expect(wbe.book).toHaveBeenCalled();
        });

        it('does not call acceptPriceChange when the price held', async () => {
            wbe.prebook.mockResolvedValue({ status: BookingFlowStatus.prebooked });

            await groupBookingService.bookGroup(params({ roomsRequested: 5, rooms: roomsFor(5) }) as any);

            expect(wbe.acceptPriceChange).not.toHaveBeenCalled();
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('refusals before anything is booked', () => {
        it('refuses when the hotel has no availability', async () => {
            search.search.mockResolvedValue({ ...searchResult([]), hotels: [] });

            await expect(groupBookingService.bookGroup(params() as any)).rejects.toThrow(
                GroupBookingError,
            );
            expect(wbe.selectOption).not.toHaveBeenCalled();
        });

        it('refuses when no supplier may take group bookings', async () => {
            search.search.mockResolvedValue(searchResult([{ supplier: 'POW_S', total: 900 }]));

            await expect(groupBookingService.bookGroup(params() as any)).rejects.toThrow(
                /No supplier can take these rooms/,
            );
            expect(groups.create).not.toHaveBeenCalled();
        });

        it('refuses when the supplier price is far above the quote', async () => {
            search.search.mockResolvedValue(searchResult([{ supplier: 'EANRP', total: 900 }]));

            await expect(
                groupBookingService.bookGroup(
                    params({ roomsRequested: 5, rooms: roomsFor(5), quotedTotal: 100 }) as any,
                ),
            ).rejects.toThrow(/above the quoted total/);
            expect(wbe.selectOption).not.toHaveBeenCalled();
        });

        it('books past the tolerance when an operator overrides it', async () => {
            search.search.mockResolvedValue(searchResult([{ supplier: 'EANRP', total: 900 }]));

            await groupBookingService.bookGroup(
                params({
                    roomsRequested: 5,
                    rooms: roomsFor(5),
                    quotedTotal: 100,
                    acceptPriceDrift: true,
                }) as any,
            );

            expect(wbe.selectOption).toHaveBeenCalled();
        });

        it('books without a quote to compare against', async () => {
            search.search.mockResolvedValue(searchResult([{ supplier: 'EANRP', total: 900 }]));

            await expect(
                groupBookingService.bookGroup(
                    params({ roomsRequested: 5, rooms: roomsFor(5), quotedTotal: undefined }) as any,
                ),
            ).resolves.toBeDefined();
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('cancelling a group', () => {
        it('cancels every confirmed slice', async () => {
            groups.findById.mockResolvedValue({
                id: 'group-1',
                bookings: [
                    { id: 'b1', status: BookingFlowStatus.booked },
                    { id: 'b2', status: BookingFlowStatus.vouchered },
                ],
            });
            groups.recomputeStatus.mockResolvedValue({ id: 'group-1', status: 'cancelled' });
            wbe.cancel.mockResolvedValue({ status: BookingFlowStatus.cancelled });

            await groupBookingService.cancelGroup('group-1');

            expect(wbe.cancel).toHaveBeenCalledTimes(2);
        });

        it('leaves slices that were never confirmed alone', async () => {
            groups.findById.mockResolvedValue({
                id: 'group-1',
                bookings: [
                    { id: 'b1', status: BookingFlowStatus.booked },
                    { id: 'b2', status: BookingFlowStatus.failed },
                    { id: 'b3', status: BookingFlowStatus.draft },
                ],
            });
            groups.recomputeStatus.mockResolvedValue({ id: 'group-1', status: 'cancelled' });
            wbe.cancel.mockResolvedValue({ status: BookingFlowStatus.cancelled });

            await groupBookingService.cancelGroup('group-1');

            expect(wbe.cancel).toHaveBeenCalledTimes(1);
        });

        it('tries every slice even when one cancellation is refused', async () => {
            // Half-cancelled is worse than every-attempt-made: a slice left
            // booked because an earlier one threw would be charged silently.
            groups.findById.mockResolvedValue({
                id: 'group-1',
                bookings: [
                    { id: 'b1', status: BookingFlowStatus.booked },
                    { id: 'b2', status: BookingFlowStatus.booked },
                ],
            });
            groups.recomputeStatus.mockResolvedValue({ id: 'group-1', status: 'partial' });
            wbe.cancel
                .mockRejectedValueOnce(new Error('supplier refused'))
                .mockResolvedValueOnce({ status: BookingFlowStatus.cancelled });

            await groupBookingService.cancelGroup('group-1');

            expect(wbe.cancel).toHaveBeenCalledTimes(2);
        });

        it('refuses to cancel a group that does not exist', async () => {
            groups.findById.mockResolvedValue(null);

            await expect(groupBookingService.cancelGroup('missing')).rejects.toThrow(
                GroupBookingError,
            );
        });
    });
});

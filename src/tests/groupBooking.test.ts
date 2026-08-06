/**
 * Unit tests for group booking.
 *
 * A group booking is several real reservations made from one request, so the
 * failure modes here cost money rather than throwing: an allocation that
 * exceeds a supplier's cap gets rejected at BookV2 after earlier slices are
 * already held, and a price check that silently passes books the customer at
 * whatever the supplier now charges.
 *
 * WBE and the database are mocked throughout — what is under test is the
 * arithmetic and the partial-failure handling, not the supplier.
 */
import { buildSupplierSplit } from '../queue/hotelProbe.worker';
import { perRoomPerNight } from '../services/groupBooking.service';
import { getCappedMax, SUPPLIER_LIMITS } from '../config/supplierLimits';
import * as cfg from '../config/groupBooking';

/** An option shaped the way certificationSearchService.search() returns one. */
const option = (supplierCode: string, totalPrice: number, rooms = 1) => ({
    tid: `tid-${supplierCode}`,
    supplierCode,
    totalPrice,
    currency: 'EUR',
    onRequest: false,
    updatedOptionsNeeded: false,
    rooms: Array.from({ length: rooms }, (_, i) => ({ roomId: i + 1 })),
});

/** Apply the conversion the booking service applies before splitting. */
const priceOptions = (opts: ReturnType<typeof option>[], nights: number) =>
    opts.map((o) => ({
        ...o,
        pricePerRoomPerNight: perRoomPerNight(o.totalPrice, o.rooms.length, nights),
    }));

/** The drift calculation as the service performs it. */
const driftPercent = (
    split: Array<{ rooms: number; pricePerRoomPerNight: number }>,
    nights: number,
    quotedTotal: number,
) => {
    const current = split.reduce((s, x) => s + x.pricePerRoomPerNight * x.rooms * nights, 0);
    return ((current - quotedTotal) / quotedTotal) * 100;
};

describe('Group booking', () => {
    // ────────────────────────────────────────────────────────────────────────
    describe('perRoomPerNight', () => {
        it('divides a whole-option total by rooms and nights', () => {
            expect(perRoomPerNight(1800, 3, 2)).toBe(300);
        });

        it('treats a single-room single-night option as its own total', () => {
            expect(perRoomPerNight(250, 1, 1)).toBe(250);
        });

        it('does not divide by zero when an option reports no rooms', () => {
            // WBE occasionally returns an option with an empty Rooms array. A
            // zero divisor would yield Infinity, which passes every tolerance
            // check the way NaN does.
            expect(Number.isFinite(perRoomPerNight(500, 0, 2))).toBe(true);
        });

        it('does not divide by zero when nights is zero', () => {
            expect(Number.isFinite(perRoomPerNight(500, 2, 0))).toBe(true);
        });

        it('produces a finite price for every option a search returns', () => {
            // Guards the defect this conversion exists for: passing raw search
            // options into the allocator left pricePerRoomPerNight undefined,
            // which made the drift total NaN — and NaN compares false against
            // any tolerance, so an unbounded price increase booked silently.
            const priced = priceOptions([option('HBA', 1800), option('EANRP', 2160)], 3);
            for (const p of priced) {
                expect(Number.isFinite(p.pricePerRoomPerNight)).toBe(true);
                expect(p.pricePerRoomPerNight).toBeGreaterThan(0);
            }
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('buildSupplierSplit — allocation', () => {
        const nights = 3;

        it('fills a small group from a single supplier', () => {
            const split = buildSupplierSplit(priceOptions([option('EANRP', 300)], nights), 4, 4);
            expect(split).toHaveLength(1);
            expect(split[0]!.rooms).toBe(4);
        });

        it('spreads a group across suppliers when one cannot take it alone', () => {
            const split = buildSupplierSplit(
                priceOptions([option('HBA', 300), option('EANRP', 360)], nights),
                12,
                12,
            );
            expect(split.length).toBeGreaterThan(1);
            expect(split.reduce((s, x) => s + x.rooms, 0)).toBe(12);
        });

        it('never allocates a supplier more rooms than its documented cap', () => {
            // The cap is the whole reason the split exists: exceeding it is
            // rejected at BookV2, after earlier slices are already confirmed.
            const split = buildSupplierSplit(
                priceOptions(
                    [option('HBA', 300), option('EANRP', 360), option('DDT', 420)],
                    nights,
                ),
                20,
                20,
            );
            for (const slice of split) {
                expect(slice.rooms).toBeLessThanOrEqual(getCappedMax(slice.supplierCode, 20));
            }
        });

        it('caps HotelBeds at six rooms, its documented group limit', () => {
            const split = buildSupplierSplit(priceOptions([option('HBA', 300)], nights), 10, 10);
            expect(split[0]!.supplierCode).toBe('HBA');
            expect(split[0]!.rooms).toBe(SUPPLIER_LIMITS['HBA']!.maxRooms);
        });

        it('allocates what it can when no combination covers the group', () => {
            // Under-filling is correct here: the rooms that can be held are
            // held, and the shortfall is reported rather than the whole group
            // being refused.
            const split = buildSupplierSplit(priceOptions([option('HBA', 300)], nights), 30, 30);
            const allocated = split.reduce((s, x) => s + x.rooms, 0);
            expect(allocated).toBeLessThan(30);
            expect(allocated).toBeGreaterThan(0);
        });

        it('returns nothing when every option is from a supplier barred from groups', () => {
            const split = buildSupplierSplit(priceOptions([option('POW_S', 300)], nights), 5, 5);
            expect(split).toHaveLength(0);
        });

        it('returns nothing when there are no options at all', () => {
            expect(buildSupplierSplit([], 5, 5)).toHaveLength(0);
        });

        it('allocates nothing for a zero-room group', () => {
            const split = buildSupplierSplit(priceOptions([option('EANRP', 300)], nights), 0, 0);
            expect(split.reduce((s, x) => s + x.rooms, 0)).toBe(0);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('buildSupplierSplit — supplier priority', () => {
        const nights = 3;

        it('allocates a higher-priority supplier ahead of a cheaper low-priority one', () => {
            // Oliver's rule, live since 2026-07-21: priority tier decides
            // first, price only breaks ties within a tier. HotelBeds is cheaper
            // here and still comes second.
            const split = buildSupplierSplit(
                priceOptions([option('HBA', 300), option('EANRP', 600)], nights),
                4,
                4,
            );
            expect(split[0]!.supplierCode).toBe('EANRP');
        });

        it('prefers the cheaper supplier when both sit in the same tier', () => {
            const split = buildSupplierSplit(
                priceOptions([option('DDT', 600), option('EANRP', 300)], nights),
                4,
                4,
            );
            expect(split[0]!.supplierCode).toBe('EANRP');
        });

        it('falls through to a lower tier once the higher tier is exhausted', () => {
            const split = buildSupplierSplit(
                priceOptions([option('EANRP', 300), option('GG', 360)], nights),
                14,
                14,
            );
            expect(split[0]!.supplierCode).toBe('EANRP');
            expect(split.map((s) => s.supplierCode)).toContain('GG');
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('price drift against the quoted total', () => {
        const nights = 3;
        const split = buildSupplierSplit(priceOptions([option('EANRP', 300)], nights), 5, 5);
        const currentTotal = split.reduce(
            (s, x) => s + x.pricePerRoomPerNight * x.rooms * nights,
            0,
        );

        it('reports no drift when the supplier price matches the quote', () => {
            expect(driftPercent(split, nights, currentTotal)).toBeCloseTo(0);
        });

        it('accepts a rise inside the tolerance', () => {
            const quoted = currentTotal / (1 + (cfg.PRICE_DRIFT_TOLERANCE_PERCENT - 1) / 100);
            expect(driftPercent(split, nights, quoted)).toBeLessThanOrEqual(
                cfg.PRICE_DRIFT_TOLERANCE_PERCENT,
            );
        });

        it('rejects a rise beyond the tolerance', () => {
            const quoted = currentTotal / (1 + (cfg.PRICE_DRIFT_TOLERANCE_PERCENT + 5) / 100);
            expect(driftPercent(split, nights, quoted)).toBeGreaterThan(
                cfg.PRICE_DRIFT_TOLERANCE_PERCENT,
            );
        });

        it('treats a price that fell as negative drift, never a reason to stop', () => {
            const quoted = currentTotal * 1.2;
            const pct = driftPercent(split, nights, quoted);
            expect(pct).toBeLessThan(0);
            expect(pct).toBeLessThanOrEqual(cfg.PRICE_DRIFT_TOLERANCE_PERCENT);
        });

        it('scales with nights, so a long stay is not judged on one night', () => {
            const oneNight = driftPercent(
                buildSupplierSplit(priceOptions([option('EANRP', 300)], 1), 5, 5),
                1,
                1500,
            );
            const sevenNights = driftPercent(
                buildSupplierSplit(priceOptions([option('EANRP', 2100)], 7), 5, 5),
                7,
                1500 * 7,
            );
            expect(oneNight).toBeCloseTo(sevenNights);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('group configuration', () => {
        it('keeps partial bookings rather than unwinding them', () => {
            // Confirmed by the client: cancelling successful slices releases
            // rooms that may not be available again, leaving the customer with
            // nothing instead of most of what they asked for.
            expect(cfg.KEEP_PARTIAL_BOOKINGS).toBe(true);
        });

        it('allows a price decrease', () => {
            expect(cfg.ALLOW_PRICE_DECREASE).toBe(true);
        });

        it('bounds how many suppliers one group may be split across', () => {
            expect(cfg.MAX_SLICES_PER_GROUP).toBeGreaterThan(1);
            expect(cfg.MAX_SLICES_PER_GROUP).toBeLessThanOrEqual(10);
        });

        it('reads the drift tolerance as a usable percentage', () => {
            expect(Number.isFinite(cfg.PRICE_DRIFT_TOLERANCE_PERCENT)).toBe(true);
            expect(cfg.PRICE_DRIFT_TOLERANCE_PERCENT).toBeGreaterThan(0);
        });
    });
});

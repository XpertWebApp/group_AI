/**
 * Unit tests for the passenger manifest generator.
 *
 * Two things are being protected here. WBE rejects a manifest whose counts
 * disagree with the occupancy the option was priced for — and it does so after
 * the prebook is consumed, so the reservation attempt is already spent. And
 * suppliers auto-cancel bookings whose passenger lists look fabricated, days
 * later and without telling us, which is why the names have to read like a real
 * rooming list rather than a sequence of test values.
 */
import {
    buildPassengerManifest,
    roomsFromBreakdown,
} from '../services/passengerManifest.service';
import { validatePassengers } from '../services/wbeBooking.service';

describe('Passenger manifest', () => {
    // ────────────────────────────────────────────────────────────────────────
    describe('occupancy', () => {
        it('produces one room entry per requested room', () => {
            const manifest = buildPassengerManifest([{ adults: 2 }, { adults: 1 }]);
            expect(manifest).toHaveLength(2);
        });

        it('numbers rooms from one, as WBE expects', () => {
            const manifest = buildPassengerManifest([{ adults: 1 }, { adults: 1 }]);
            expect(manifest.map((r) => r.roomId)).toEqual([1, 2]);
        });

        it('fills each room with exactly the adults it was priced for', () => {
            const manifest = buildPassengerManifest([{ adults: 3 }]);
            expect(manifest[0]!.adultsNo).toBe(3);
            expect(manifest[0]!.passengers.filter((p) => !p.isChild)).toHaveLength(3);
        });

        it('adds a passenger for every child age given', () => {
            const manifest = buildPassengerManifest([{ adults: 2, childrenAges: [5, 8] }]);
            expect(manifest[0]!.childrenNo).toBe(2);
            expect(manifest[0]!.passengers.filter((p) => p.isChild)).toHaveLength(2);
        });

        it('carries each child age through unchanged', () => {
            const manifest = buildPassengerManifest([{ adults: 1, childrenAges: [3, 11] }]);
            const ages = manifest[0]!.passengers.filter((p) => p.isChild).map((p) => p.age);
            // Numeric sort: the default compares as strings, which orders 11
            // before 3 and would fail against a correct manifest.
            expect(ages.sort((a, b) => a! - b!)).toEqual([3, 11]);
        });

        it('keeps an infant at age 0 rather than dropping it', () => {
            // 0 is falsy; a truthiness check would silently omit the infant and
            // the room would be booked one passenger short.
            const manifest = buildPassengerManifest([{ adults: 2, childrenAges: [0] }]);
            const child = manifest[0]!.passengers.find((p) => p.isChild);
            expect(child?.age).toBe(0);
        });

        it('leaves adults without an age — WBE rejects Age on an adult', () => {
            const manifest = buildPassengerManifest([{ adults: 2 }]);
            for (const p of manifest[0]!.passengers.filter((x) => !x.isChild)) {
                expect(p.age).toBeUndefined();
            }
        });

        it('handles an empty room list', () => {
            expect(buildPassengerManifest([])).toEqual([]);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('the manifest WBE will accept', () => {
        it('passes the booking validator for a plain group', () => {
            const manifest = buildPassengerManifest([{ adults: 2 }, { adults: 2 }, { adults: 1 }]);
            expect(validatePassengers(manifest)).toEqual([]);
        });

        it('passes the validator for a group with children', () => {
            const manifest = buildPassengerManifest([
                { adults: 2, childrenAges: [7] },
                { adults: 2, childrenAges: [3, 9] },
            ]);
            expect(validatePassengers(manifest)).toEqual([]);
        });

        it('passes the validator for a fifteen-room group', () => {
            const manifest = buildPassengerManifest(
                Array.from({ length: 15 }, () => ({ adults: 2 })),
            );
            expect(validatePassengers(manifest)).toEqual([]);
        });

        it('marks exactly one leader across the whole booking', () => {
            // WBE uses the leader for the voucher and rejects more than one.
            const manifest = buildPassengerManifest(
                Array.from({ length: 8 }, () => ({ adults: 2 })),
            );
            const leaders = manifest.flatMap((r) => r.passengers).filter((p) => p.isLeader);
            expect(leaders).toHaveLength(1);
        });

        it('never marks a child as the leader', () => {
            const manifest = buildPassengerManifest([{ adults: 1, childrenAges: [6] }]);
            const leader = manifest[0]!.passengers.find((p) => p.isLeader);
            expect(leader?.isChild).toBe(false);
        });

        it('gives children the Chd salutation', () => {
            const manifest = buildPassengerManifest([{ adults: 2, childrenAges: [7] }]);
            const child = manifest[0]!.passengers.find((p) => p.isChild);
            expect(child?.salutation).toBe('Chd');
        });

        it('gives adults a salutation WBE accepts', () => {
            const manifest = buildPassengerManifest([{ adults: 4 }]);
            for (const p of manifest[0]!.passengers) {
                expect(['Mr', 'Ms', 'Mrs', 'Miss']).toContain(p.salutation);
            }
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('names that survive a supplier fraud check', () => {
        it('never repeats one surname across the whole group', () => {
            // The pattern suppliers cancel on: fifteen rooms all surnamed the
            // same reads as generated, not as a rooming list.
            const manifest = buildPassengerManifest(
                Array.from({ length: 12 }, () => ({ adults: 2 })),
            );
            const surnames = new Set(manifest.flatMap((r) => r.passengers.map((p) => p.lastName)));
            expect(surnames.size).toBeGreaterThan(1);
        });

        it('shares a surname within a room, so occupants read as travelling together', () => {
            const manifest = buildPassengerManifest([{ adults: 2, childrenAges: [8] }]);
            const surnames = new Set(manifest[0]!.passengers.map((p) => p.lastName));
            expect(surnames.size).toBe(1);
        });

        it('gives every passenger a first and last name', () => {
            const manifest = buildPassengerManifest([{ adults: 3, childrenAges: [4] }]);
            for (const p of manifest[0]!.passengers) {
                expect(p.firstName.trim().length).toBeGreaterThan(1);
                expect(p.lastName.trim().length).toBeGreaterThan(1);
            }
        });

        it('uses a supplied lead name when it reads like a real one', () => {
            const manifest = buildPassengerManifest([{ adults: 2 }], {
                leadFirstName: 'Hans',
                leadLastName: 'Müller',
            });
            const lead = manifest[0]!.passengers.find((p) => p.isLeader);
            expect(lead?.firstName).toBe('Hans');
            expect(lead?.lastName).toBe('Müller');
        });

        it.each([
            ['QA', 'Tester'],
            ['Test', 'Booking'],
            ['demo', 'user'],
            ['Sample', 'Guest'],
        ])('replaces the internal name "%s %s" with a placeholder', (first, last) => {
            // These reach production from staff testing and webhook smoke runs.
            // Putting one on a reservation invites the check the placeholders
            // exist to avoid.
            const manifest = buildPassengerManifest([{ adults: 2 }], {
                leadFirstName: first,
                leadLastName: last,
            });
            const lead = manifest[0]!.passengers.find((p) => p.isLeader);
            expect(lead?.firstName).not.toBe(first);
        });

        it('rejects a lead name containing digits', () => {
            const manifest = buildPassengerManifest([{ adults: 2 }], {
                leadFirstName: 'User1',
                leadLastName: 'Smith',
            });
            expect(manifest[0]!.passengers[0]!.firstName).not.toBe('User1');
        });

        it('rejects a single-letter lead name', () => {
            const manifest = buildPassengerManifest([{ adults: 2 }], {
                leadFirstName: 'A',
                leadLastName: 'B',
            });
            expect(manifest[0]!.passengers[0]!.firstName).not.toBe('A');
        });

        it('falls back to a placeholder when only half a lead name is known', () => {
            const manifest = buildPassengerManifest([{ adults: 2 }], { leadFirstName: 'Hans' });
            expect(manifest[0]!.passengers[0]!.firstName).not.toBe('Hans');
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('stability across retries', () => {
        it('produces the same manifest for the same seed', () => {
            // Rebooking a failed slice must reuse the same names: different
            // ones would make two attempts at the same rooms look like two
            // different groups to the supplier.
            const a = buildPassengerManifest([{ adults: 2 }, { adults: 2 }], { seed: 'req-1' });
            const b = buildPassengerManifest([{ adults: 2 }, { adults: 2 }], { seed: 'req-1' });
            expect(a).toEqual(b);
        });

        it('produces different manifests for different seeds', () => {
            const a = buildPassengerManifest([{ adults: 2 }], { seed: 'req-1' });
            const b = buildPassengerManifest([{ adults: 2 }], { seed: 'req-2' });
            expect(a).not.toEqual(b);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('roomsFromBreakdown', () => {
        it('expands a room-type count into individual rooms', () => {
            const rooms = roomsFromBreakdown({ single: 2, double: 3 });
            expect(rooms).toHaveLength(5);
        });

        it('gives each type the occupancy it was priced at', () => {
            expect(roomsFromBreakdown({ single: 1 })[0]!.adults).toBe(1);
            expect(roomsFromBreakdown({ double: 1 })[0]!.adults).toBe(2);
            expect(roomsFromBreakdown({ triple: 1 })[0]!.adults).toBe(3);
            expect(roomsFromBreakdown({ quadruple: 1 })[0]!.adults).toBe(4);
        });

        it('recognises the breakdown keys a request actually stores', () => {
            // The shape written by the request form, verified against a live row.
            const rooms = roomsFromBreakdown({
                twin: 0,
                double: 10,
                single: 5,
                suites: 0,
                triple: 0,
                twinBeds: 0,
                quadruple: 0,
                standardDoubleBeds: 0,
            });
            expect(rooms).toHaveLength(15);
        });

        it('ignores room types with a count of zero', () => {
            expect(roomsFromBreakdown({ single: 0, double: 2 })).toHaveLength(2);
        });

        it('refuses an unknown room type rather than guessing its occupancy', () => {
            // Guessing books the wrong occupancy, which produces a reservation
            // the customer cannot use at a price that does not match the quote.
            expect(() => roomsFromBreakdown({ penthouse: 1 })).toThrow(/Unknown room type/);
        });

        it('returns nothing for an empty breakdown', () => {
            expect(roomsFromBreakdown({})).toEqual([]);
        });
    });
});

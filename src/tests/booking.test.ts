/**
 * Unit tests for the booking module.
 *
 * Scope is deliberately the pure, WBE-independent logic: the passenger rules
 * and the Zod schemas that guard a booking payload. These are the parts that
 * decide whether a booking is accepted or rejected, and WBE only reports a
 * violation *after* consuming the prebook — so a regression here costs a real
 * reservation attempt rather than a test failure.
 *
 * No network, no database: everything below runs against exported functions
 * and schemas directly.
 */
import {
    generateAgencyReference,
    validatePassengers,
} from '../services/wbeBooking.service';
import {
    BookingPassengerSchema,
    BookingRoomSchema,
} from '../validation/bookingSchemas';
import type { CreateBookingRoomData } from '../repositories/booking.repository';

// ── Builders ────────────────────────────────────────────────────────────────
// Each test states only the field under test; everything else stays valid, so
// a failure points at one rule rather than at incidental payload drift.

const adult = (over: Partial<any> = {}) => ({
    salutation: 'Mr',
    firstName: 'John',
    lastName: 'Doe',
    isChild: false,
    isLeader: false,
    ...over,
});

const child = (over: Partial<any> = {}) => ({
    salutation: 'Chd',
    firstName: 'Amy',
    lastName: 'Doe',
    isChild: true,
    age: 7,
    isLeader: false,
    ...over,
});

const room = (over: Partial<CreateBookingRoomData> = {}): CreateBookingRoomData =>
    ({
        roomId: 1,
        adultsNo: 2,
        childrenNo: 0,
        passengers: [adult(), adult({ firstName: 'Jane', salutation: 'Ms' })],
        ...over,
    }) as CreateBookingRoomData;

describe('Booking module', () => {
    // ────────────────────────────────────────────────────────────────────────
    describe('generateAgencyReference', () => {
        it('uses the SETT prefix by default', () => {
            expect(generateAgencyReference()).toMatch(/^SETT-/);
        });

        it('honours a custom prefix', () => {
            expect(generateAgencyReference('CERT')).toMatch(/^CERT-/);
        });

        it('produces the three-part shape WBE expects', () => {
            expect(generateAgencyReference()).toMatch(/^SETT-[0-9A-Z]+-[0-9A-Z]{6}$/);
        });

        it('does not repeat across rapid successive calls', () => {
            // WBE requires global uniqueness per booking; a duplicate would
            // risk attaching to an existing reservation.
            const refs = new Set(Array.from({ length: 500 }, () => generateAgencyReference()));
            expect(refs.size).toBe(500);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('validatePassengers', () => {
        it('accepts a correctly filled adults-only room', () => {
            expect(validatePassengers([room()])).toEqual([]);
        });

        it('accepts a room with adults and children', () => {
            const r = room({
                adultsNo: 2,
                childrenNo: 1,
                passengers: [adult(), adult({ salutation: 'Ms' }), child()],
            });
            expect(validatePassengers([r])).toEqual([]);
        });

        it('accepts age 0 for an infant', () => {
            // 0 is falsy — a truthiness check here would wrongly reject infants,
            // and certification scenario 5 books a 1-year-old.
            const r = room({
                adultsNo: 1,
                childrenNo: 1,
                passengers: [adult(), child({ age: 0 })],
            });
            expect(validatePassengers([r])).toEqual([]);
        });

        it('rejects fewer adults than declared', () => {
            const r = room({ adultsNo: 2, passengers: [adult()] });
            expect(validatePassengers([r])).toEqual([
                expect.stringContaining('expected 2 adult passenger(s), got 1'),
            ]);
        });

        it('rejects more adults than declared', () => {
            const r = room({ adultsNo: 1, passengers: [adult(), adult()] });
            expect(validatePassengers([r])).toEqual([
                expect.stringContaining('expected 1 adult passenger(s), got 2'),
            ]);
        });

        it('rejects a child count that does not match the manifest', () => {
            const r = room({
                adultsNo: 2,
                childrenNo: 2,
                passengers: [adult(), adult(), child()],
            });
            expect(validatePassengers([r])).toEqual([
                expect.stringContaining('expected 2 child passenger(s), got 1'),
            ]);
        });

        it('requires an age on every child', () => {
            const r = room({
                adultsNo: 1,
                childrenNo: 1,
                passengers: [adult(), child({ age: undefined })],
            });
            expect(validatePassengers([r])).toEqual([
                expect.stringContaining('age is required for child passengers'),
            ]);
        });

        it('requires the Chd salutation on a child', () => {
            const r = room({
                adultsNo: 1,
                childrenNo: 1,
                passengers: [adult(), child({ salutation: 'Mr' })],
            });
            expect(validatePassengers([r])).toEqual([
                expect.stringContaining('salutation must be "Chd"'),
            ]);
        });

        it.each(['Mr', 'Ms', 'Mrs', 'Miss'])('accepts %s as an adult salutation', (salutation) => {
            const r = room({ adultsNo: 1, passengers: [adult({ salutation })] });
            expect(validatePassengers([r])).toEqual([]);
        });

        it('rejects an adult salutation outside the allowed set', () => {
            const r = room({ adultsNo: 1, passengers: [adult({ salutation: 'Dr' })] });
            expect(validatePassengers([r])).toEqual([
                expect.stringContaining('salutation must be Mr, Ms, Mrs or Miss'),
            ]);
        });

        it('requires a first name', () => {
            const r = room({ adultsNo: 1, passengers: [adult({ firstName: '   ' })] });
            expect(validatePassengers([r])).toEqual([
                expect.stringContaining('firstName is required'),
            ]);
        });

        it('requires a last name', () => {
            const r = room({ adultsNo: 1, passengers: [adult({ lastName: '' })] });
            expect(validatePassengers([r])).toEqual([
                expect.stringContaining('lastName is required'),
            ]);
        });

        it('allows exactly one leader across all rooms', () => {
            const rooms = [
                room({ roomId: 1, adultsNo: 1, passengers: [adult({ isLeader: true })] }),
                room({ roomId: 2, adultsNo: 1, passengers: [adult()] }),
            ];
            expect(validatePassengers(rooms)).toEqual([]);
        });

        it('rejects more than one leader across rooms', () => {
            const rooms = [
                room({ roomId: 1, adultsNo: 1, passengers: [adult({ isLeader: true })] }),
                room({ roomId: 2, adultsNo: 1, passengers: [adult({ isLeader: true })] }),
            ];
            expect(validatePassengers(rooms)).toEqual([
                expect.stringContaining('Only one passenger may be marked as leader'),
            ]);
        });

        it('reports every problem at once rather than stopping at the first', () => {
            // The caller surfaces these to the operator before any WBE call, so
            // a partial list would mean fixing one error only to hit the next.
            const r = room({
                adultsNo: 2,
                childrenNo: 1,
                passengers: [adult({ firstName: '' }), child({ age: undefined, salutation: 'Mr' })],
            });
            const errors = validatePassengers(r ? [r] : []);
            expect(errors.length).toBeGreaterThanOrEqual(4);
        });

        it('labels errors with the room they came from', () => {
            const rooms = [
                room({ roomId: 1, adultsNo: 1, passengers: [adult()] }),
                room({ roomId: 2, adultsNo: 2, passengers: [adult()] }),
            ];
            expect(validatePassengers(rooms)).toEqual([
                expect.stringContaining('Room 2'),
            ]);
        });

        it('returns no errors for an empty room list', () => {
            expect(validatePassengers([])).toEqual([]);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('BookingPassengerSchema', () => {
        it('accepts a valid adult', () => {
            expect(BookingPassengerSchema.safeParse(adult()).success).toBe(true);
        });

        it('accepts a valid child', () => {
            expect(BookingPassengerSchema.safeParse(child()).success).toBe(true);
        });

        it('rejects an adult carrying an age — WBE rejects Age on an adult', () => {
            const res = BookingPassengerSchema.safeParse(adult({ age: 30 }));
            expect(res.success).toBe(false);
        });

        it('rejects a child without an age', () => {
            const res = BookingPassengerSchema.safeParse(child({ age: undefined }));
            expect(res.success).toBe(false);
        });

        it('rejects a child using an adult salutation', () => {
            const res = BookingPassengerSchema.safeParse(child({ salutation: 'Mr' }));
            expect(res.success).toBe(false);
        });

        it('rejects an adult using the child salutation', () => {
            const res = BookingPassengerSchema.safeParse(adult({ salutation: 'Chd' }));
            expect(res.success).toBe(false);
        });

        it('accepts the boundary child ages 0 and 17', () => {
            expect(BookingPassengerSchema.safeParse(child({ age: 0 })).success).toBe(true);
            expect(BookingPassengerSchema.safeParse(child({ age: 17 })).success).toBe(true);
        });

        it('rejects a child age above 17', () => {
            expect(BookingPassengerSchema.safeParse(child({ age: 18 })).success).toBe(false);
        });

        it('rejects a negative child age', () => {
            expect(BookingPassengerSchema.safeParse(child({ age: -1 })).success).toBe(false);
        });

        it('rejects a blank first name', () => {
            expect(BookingPassengerSchema.safeParse(adult({ firstName: '   ' })).success).toBe(false);
        });

        it('defaults isLeader to false when omitted', () => {
            const { isLeader, ...withoutLeader } = adult();
            const res = BookingPassengerSchema.safeParse(withoutLeader);
            expect(res.success).toBe(true);
            if (res.success) expect(res.data.isLeader).toBe(false);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    describe('BookingRoomSchema', () => {
        it('accepts a room whose manifest matches its declared occupancy', () => {
            expect(BookingRoomSchema.safeParse(room()).success).toBe(true);
        });

        it('rejects an occupancy mismatch', () => {
            const res = BookingRoomSchema.safeParse(room({ adultsNo: 3 }));
            expect(res.success).toBe(false);
        });

        it('rejects a room with no passengers', () => {
            expect(BookingRoomSchema.safeParse(room({ passengers: [] })).success).toBe(false);
        });

        it('rejects roomId 0 — WBE room ids are 1-based', () => {
            expect(BookingRoomSchema.safeParse(room({ roomId: 0 })).success).toBe(false);
        });

        it('rejects a room declaring zero adults', () => {
            const res = BookingRoomSchema.safeParse(
                room({ adultsNo: 0, childrenNo: 1, passengers: [child()] }),
            );
            expect(res.success).toBe(false);
        });

        it('accepts optional extras as supplement ids', () => {
            expect(BookingRoomSchema.safeParse(room({ optionalExtras: [11, 42] })).success).toBe(true);
        });

        it('rejects a negative price', () => {
            expect(BookingRoomSchema.safeParse(room({ price: -1 })).success).toBe(false);
        });
    });
});

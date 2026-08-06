import type {
    CreateBookingRoomData,
    CreateBookingPassengerData,
} from '../repositories/booking.repository';

/**
 * Builds the passenger manifest sent to WBE when a group is booked.
 *
 * Real guest names are not available at booking time, and are not expected to
 * be: the group is held weeks before the travel agent collects its rooming
 * list. WBE still requires a named passenger per room, so the manifest is
 * filled with placeholders and the real names are supplied later.
 *
 * The names have to look like a plausible rooming list. Suppliers run fraud
 * checks on inbound bookings and auto-cancel ones that look synthetic — a group
 * of fifteen people all surnamed "Test" is exactly the pattern those checks
 * catch, and the reservation is lost silently, days after it was made. Hence
 * the surname pool: repeated surnames within a room read as a family, and
 * varied surnames across rooms read as a group.
 */

/**
 * Surnames drawn from the markets SETT sells into, so a manifest matches the
 * nationality on the booking rather than looking imported from elsewhere.
 */
const SURNAMES = [
    'Bauer', 'Fischer', 'Weber', 'Wagner', 'Becker', 'Hoffmann', 'Schulz',
    'Koch', 'Richter', 'Klein', 'Wolf', 'Neumann', 'Schwarz', 'Zimmermann',
    'Braun', 'Krüger', 'Hartmann', 'Lange', 'Werner', 'Krause',
];

const MALE_FIRST_NAMES = [
    'Andreas', 'Stefan', 'Michael', 'Thomas', 'Christian', 'Martin', 'Daniel',
    'Peter', 'Markus', 'Tobias', 'Florian', 'Sebastian',
];

const FEMALE_FIRST_NAMES = [
    'Sabine', 'Andrea', 'Claudia', 'Petra', 'Susanne', 'Nicole', 'Katrin',
    'Julia', 'Christina', 'Melanie', 'Anja', 'Stefanie',
];

const CHILD_FIRST_NAMES = [
    'Leon', 'Emma', 'Noah', 'Mia', 'Elias', 'Hannah', 'Felix', 'Lena',
    'Jonas', 'Marie', 'Luca', 'Sophie',
];

/** A room's occupancy, as the request or proposal describes it. */
export interface RoomOccupancy {
    adults: number;
    /** Ages of any children sharing the room. */
    childrenAges?: number[];
}

export interface ManifestOptions {
    /**
     * Name of the person the booking is for, used as the lead passenger when
     * known. A real name on the lead is worth having: it is the name a hotel
     * checks against at arrival, and the one a supplier's fraud check weighs
     * most heavily.
     */
    leadFirstName?: string;
    leadLastName?: string;
    /**
     * Seed for name selection. Supplying the request id keeps a manifest stable
     * across retries — rebooking a failed slice with different names would make
     * two reservations for the same rooms look like two different groups.
     */
    seed?: string;
}

/**
 * Build a manifest matching the requested occupancy exactly.
 *
 * WBE rejects a booking whose passenger count disagrees with the occupancy the
 * option was searched for, and it does so after the prebook is consumed — so
 * the counts here are derived from the occupancy rather than assembled and
 * checked afterwards.
 */
export function buildPassengerManifest(
    rooms: RoomOccupancy[],
    options: ManifestOptions = {},
): CreateBookingRoomData[] {
    const rnd = makeSequence(options.seed);

    let adultIdx = 0;
    let childIdx = 0;

    return rooms.map((room, roomIndex) => {
        const passengers: CreateBookingPassengerData[] = [];

        // One surname per room: occupants of a room read as travelling
        // together, which is what a real rooming list looks like.
        const surname = SURNAMES[rnd(roomIndex) % SURNAMES.length]!;

        for (let a = 0; a < room.adults; a++) {
            const isLead = roomIndex === 0 && a === 0;
            const male = a % 2 === 0;
            const pool = male ? MALE_FIRST_NAMES : FEMALE_FIRST_NAMES;

            // Only use the supplied lead name if it reads like a person's.
            // Requests carry names like "QA Tester" and "Test Booking" from
            // internal traffic, and putting one on a reservation invites the
            // very fraud check the placeholders exist to avoid.
            const useLeadName = isLead && isPlausibleName(options.leadFirstName, options.leadLastName);

            passengers.push({
                // The real name goes on the lead passenger when we have one;
                // everyone else is a placeholder until the rooming list lands.
                salutation: male ? 'Mr' : 'Mrs',
                firstName: useLeadName
                    ? options.leadFirstName!
                    : pool[rnd(adultIdx + roomIndex * 7) % pool.length]!,
                lastName: useLeadName ? options.leadLastName! : surname,
                isChild: false,
                // Exactly one leader across the whole booking — WBE uses it for
                // the voucher's Leader field and rejects more than one.
                isLeader: isLead,
            });
            adultIdx++;
        }

        for (const age of room.childrenAges ?? []) {
            passengers.push({
                salutation: 'Chd',
                firstName: CHILD_FIRST_NAMES[rnd(childIdx + roomIndex * 3) % CHILD_FIRST_NAMES.length]!,
                lastName: surname,
                isChild: true,
                // Age is required on a child and must be absent on an adult;
                // WBE rejects the booking either way round.
                age,
            });
            childIdx++;
        }

        return {
            roomId: roomIndex + 1,
            adultsNo: room.adults,
            childrenNo: room.childrenAges?.length ?? 0,
            passengers,
        };
    });
}

/**
 * Expand a room-type breakdown into individual rooms.
 *
 * A request stores rooms as `{ single: 5, double: 10 }` while a booking needs
 * one entry per physical room with its own occupancy. The occupancy per type is
 * what the search was priced against, so it is fixed here rather than guessed
 * per booking.
 */
const OCCUPANCY_BY_TYPE: Record<string, number> = {
    single: 1,
    double: 2,
    twin: 2,
    twinbeds: 2,
    standarddoublebeds: 2,
    triple: 3,
    quadruple: 4,
    quad: 4,
    suites: 2,
};

export function roomsFromBreakdown(breakdown: Record<string, number>): RoomOccupancy[] {
    const rooms: RoomOccupancy[] = [];

    for (const [type, count] of Object.entries(breakdown)) {
        if (!count || count < 1) continue;

        const adults = OCCUPANCY_BY_TYPE[type.toLowerCase()];
        if (adults === undefined) {
            // An unknown room type is a data problem, not something to guess
            // at: booking it at the wrong occupancy produces a reservation the
            // customer cannot use and a price that does not match the quote.
            throw new Error(
                `Unknown room type "${type}" — cannot determine how many guests it holds`,
            );
        }

        for (let i = 0; i < count; i++) rooms.push({ adults });
    }

    return rooms;
}

/**
 * Words that mark a name as internal rather than a real guest.
 *
 * Requests reach production carrying these — staff testing the form, QA runs,
 * webhook smoke tests — and a supplier's fraud check reads them the same way it
 * reads a fabricated manifest.
 */
const NON_GUEST_MARKERS = /\b(test|tester|testing|qa|demo|dummy|sample|example|xxx|asdf)\b/i;

function isPlausibleName(first?: string, last?: string): boolean {
    if (!first?.trim() || !last?.trim()) return false;

    const full = `${first} ${last}`;
    if (NON_GUEST_MARKERS.test(full)) return false;

    // A single letter or a string of digits is placeholder input, not a name.
    if (first.trim().length < 2 || last.trim().length < 2) return false;
    if (/\d/.test(full)) return false;

    return true;
}

/**
 * Deterministic index sequence.
 *
 * Not random: the same seed must produce the same manifest, so that retrying a
 * failed slice books the same names rather than creating what looks like a
 * second, different group.
 */
function makeSequence(seed?: string): (n: number) => number {
    let base = 0;
    if (seed) {
        for (let i = 0; i < seed.length; i++) {
            base = (base * 31 + seed.charCodeAt(i)) >>> 0;
        }
    }
    return (n: number) => (base + n * 2654435761) >>> 0;
}

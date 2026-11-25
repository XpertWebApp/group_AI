/**
 * The 14 test scenarios from WBE's SmartKonnect XMLOUT Certification document.
 *
 * Transcribed verbatim from the certification PDF. `mealType: 'RO'` is applied
 * only where the document explicitly says "Room Only"; scenarios that say "Any
 * meal plan" leave it undefined so no option is filtered out.
 *
 * `refundable: false` marks the two scenarios WBE lists as Nonrefundable.
 * Those bookings cannot be cancelled without charge — WBE vouchers them
 * automatically — so the runner refuses to book them unless explicitly
 * authorised. See ALLOW_NONREFUNDABLE in config.ts.
 */

export interface ScenarioRoom {
    adults: number;
    /** One entry per child; the child count is derived from the length. */
    childrenAges?: number[];
}

export interface CertificationScenario {
    /** Scenario number as printed in WBE's document (1-14). */
    id: number;
    description: string;
    nights: number;
    rooms: ScenarioRoom[];
    /** 'RO' where the document mandates Room Only; undefined = any meal plan. */
    mealType?: string;
    /** False for the two Nonrefundable scenarios, which incur real charges. */
    refundable: boolean;
}

export const CERTIFICATION_SCENARIOS: CertificationScenario[] = [
    {
        id: 1,
        description: '1 room — 2 adults, 1 child (7 years) • Room Only • 2 nights',
        nights: 2,
        rooms: [{ adults: 2, childrenAges: [7] }],
        mealType: 'RO',
        refundable: true,
    },
    {
        id: 2,
        description: '2 rooms — A: 2 adults + 2 children (5, 8) / B: 2 adults + 1 child (3) • Any meal • Any nights',
        // "Any number of nights" — 3 chosen as a mid-range stay.
        nights: 3,
        rooms: [
            { adults: 2, childrenAges: [5, 8] },
            { adults: 2, childrenAges: [3] },
        ],
        refundable: true,
    },
    {
        id: 3,
        description: '1 room — 1 adult • Room Only • 4 nights',
        nights: 4,
        rooms: [{ adults: 1 }],
        mealType: 'RO',
        refundable: true,
    },
    {
        id: 4,
        description: '2 rooms — A: 2 adults / B: 3 adults + 1 child (4) • Any meal • 3 nights',
        nights: 3,
        rooms: [{ adults: 2 }, { adults: 3, childrenAges: [4] }],
        refundable: true,
    },
    {
        id: 5,
        description: '2 rooms — A: 2 adults + 1 child (1) / B: 2 adults • Any meal • 7 nights',
        nights: 7,
        rooms: [{ adults: 2, childrenAges: [1] }, { adults: 2 }],
        refundable: true,
    },
    {
        id: 6,
        description: '1 room — 3 adults • Any meal • 10 nights',
        nights: 10,
        rooms: [{ adults: 3 }],
        refundable: true,
    },
    {
        id: 7,
        description: '2 rooms — A: 2 adults / B: 2 adults • Room Only • 2 nights',
        nights: 2,
        rooms: [{ adults: 2 }, { adults: 2 }],
        mealType: 'RO',
        refundable: true,
    },
    {
        id: 8,
        description: '1 room — 2 adults, 2 children (7, 8) • Room Only • 5 nights',
        nights: 5,
        rooms: [{ adults: 2, childrenAges: [7, 8] }],
        mealType: 'RO',
        refundable: true,
    },
    {
        id: 9,
        description: '3 rooms — A: 2 adults / B: 2 adults + 2 children (3, 3) / C: 3 adults • Room Only • 3 nights',
        nights: 3,
        rooms: [
            { adults: 2 },
            { adults: 2, childrenAges: [3, 3] },
            { adults: 3 },
        ],
        mealType: 'RO',
        refundable: true,
    },
    {
        id: 10,
        description: '2 rooms — A: 3 adults / B: 4 adults • Any meal • 4 nights',
        nights: 4,
        rooms: [{ adults: 3 }, { adults: 4 }],
        refundable: true,
    },
    {
        id: 11,
        description: '4 rooms — A: 1 adult / B: 1 adult + 2 children (6, 9) / C: 1 adult / D: 2 adults • Any meal • 3 nights',
        nights: 3,
        rooms: [
            { adults: 1 },
            { adults: 1, childrenAges: [6, 9] },
            { adults: 1 },
            { adults: 2 },
        ],
        refundable: true,
    },
    {
        id: 12,
        description: '1 room — 6 adults, 1 child (8) • Room Only • 2 nights',
        nights: 2,
        rooms: [{ adults: 6, childrenAges: [8] }],
        mealType: 'RO',
        refundable: true,
    },
    {
        id: 13,
        description: '1 room — 2 adults, 1 child (7) • Room Only • 2 nights • NONREFUNDABLE',
        nights: 2,
        rooms: [{ adults: 2, childrenAges: [7] }],
        mealType: 'RO',
        refundable: false,
    },
    {
        id: 14,
        description: '1 room — 2 adults, 2 children (7, 8) • Room Only • 3 nights • NONREFUNDABLE',
        nights: 3,
        rooms: [{ adults: 2, childrenAges: [7, 8] }],
        mealType: 'RO',
        refundable: false,
    },
];

/** Total passengers across all rooms — used to name placeholder passengers. */
export function totalPassengers(scenario: CertificationScenario): number {
    return scenario.rooms.reduce(
        (sum, r) => sum + r.adults + (r.childrenAges?.length ?? 0),
        0,
    );
}

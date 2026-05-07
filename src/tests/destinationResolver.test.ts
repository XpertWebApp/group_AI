import destinationRepository from '../repositories/destination.repository';

/**
 * Integration tests for the destination resolver.
 *
 * These hit the live master.destinations + master.hotels tables. The
 * assertions reference well-known WBE-assigned destination IDs and hotel
 * counts that are stable in the synced master data:
 *   - 36754 New York City-NY  → 913 hotels  (most-bookable "New York")
 *   - 36753 New York-NJ       →   0 hotels  (the wrong pick before this fix)
 *   - 30279 London            → 2117 hotels (most-bookable "London")
 *   - 39707 Paris             → 1891 hotels (most-bookable "Paris")
 */

describe('DestinationRepository.resolveByName — inventory ranking', () => {
    it('"New York" resolves to NYC-NY (913 hotels), not NJ (0 hotels)', async () => {
        const result = await destinationRepository.resolveByName('New York');
        expect(result.id).toBe(36754);
        expect(result.name).toMatch(/New York City-NY/i);
        expect(result.hotelCount).toBeGreaterThan(0);
        // Strategy: there is no destination LITERALLY named "New York", so the
        // walk falls through to startsWith — both NJ and NYC-NY match, NYC wins
        // by inventory.
        expect(result.matchStrategy).toBe('startsWith');
    });

    it('"London" picks the high-inventory London (id 30279)', async () => {
        const result = await destinationRepository.resolveByName('London');
        expect(result.id).toBe(30279);
        expect(result.matchStrategy).toBe('exact');
        expect(result.hotelCount).toBeGreaterThan(1000);
    });

    it('"Paris" picks central Paris (id 39707), not a Paris suburb', async () => {
        const result = await destinationRepository.resolveByName('Paris');
        expect(result.id).toBe(39707);
        expect(result.matchStrategy).toBe('exact');
        expect(result.hotelCount).toBeGreaterThan(1000);
    });

    it('empty string returns id=0 with matchStrategy "none"', async () => {
        const result = await destinationRepository.resolveByName('');
        expect(result.id).toBe(0);
        expect(result.matchStrategy).toBe('none');
        expect(result.hotelCount).toBe(0);
    });

    it('whitespace-only string returns id=0 with matchStrategy "none"', async () => {
        const result = await destinationRepository.resolveByName('   ');
        expect(result.id).toBe(0);
        expect(result.matchStrategy).toBe('none');
    });

    it('unknown name (no match anywhere) returns id=0', async () => {
        const result = await destinationRepository.resolveByName('Zxqzpwlkrnyq');
        expect(result.id).toBe(0);
        expect(result.matchStrategy).toBe('none');
    });

    it('first-word fallback resolves multi-word inputs that have no contains match', async () => {
        // "Paris Foobar Nonsense" has no contains/startsWith match as a whole,
        // but its first word "Paris" matches → falls back to firstWord strategy.
        const result = await destinationRepository.resolveByName('Paris Foobar Nonsense');
        expect(result.matchStrategy).toBe('firstWord');
        expect(result.id).toBe(39707);
    });

    it('"Orlando" skips the zero-inventory exact match and resolves to Orlando-FL', async () => {
        // Master data has TWO rows: "Orlando" (id 38646, 0 hotels) and
        // "Orlando-Fl" (id 38647, 744 hotels). The exact-name match wins on
        // strategy precedence, but it has no inventory — the resolver must
        // fall through and pick the populated startsWith match.
        const result = await destinationRepository.resolveByName('Orlando');
        expect(result.id).toBe(38647);
        expect(result.name).toMatch(/Orlando-Fl/i);
        expect(result.hotelCount).toBeGreaterThan(0);
        expect(result.matchStrategy).toBe('startsWith');
    });
});

describe('DestinationRepository.searchByName — dropdown ordering', () => {
    it('"New York" lists NYC-NY first, NJ stays visible at the bottom', async () => {
        const rows = await destinationRepository.searchByName('New York', 10);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0]!.id).toBe(36754);
        expect(rows[0]!.hotelCount).toBeGreaterThan(0);

        const nj = rows.find((r) => r.id === 36753);
        if (nj) {
            // Zero-inventory destinations must NEVER be first.
            const njIndex = rows.indexOf(nj);
            expect(njIndex).toBeGreaterThan(0);
            expect(nj.hotelCount).toBe(0);
        }
    });

    it('returns hotelCount on every row', async () => {
        const rows = await destinationRepository.searchByName('Paris', 5);
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
            expect(typeof r.hotelCount).toBe('number');
            expect(r.hotelCount).toBeGreaterThanOrEqual(0);
        }
    });

    it('rows are sorted by hotelCount descending', async () => {
        const rows = await destinationRepository.searchByName('London', 10);
        for (let i = 1; i < rows.length; i++) {
            expect(rows[i - 1]!.hotelCount).toBeGreaterThanOrEqual(rows[i]!.hotelCount);
        }
    });

    it('queries shorter than 2 chars return an empty array', async () => {
        expect(await destinationRepository.searchByName('', 10)).toEqual([]);
        expect(await destinationRepository.searchByName('a', 10)).toEqual([]);
    });
});

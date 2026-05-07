import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

export type MatchStrategy = 'exact' | 'startsWith' | 'contains' | 'firstWord' | 'none';

export interface DestinationSearchRow {
    id: number;
    name: string;
    countryCode: string | null;
    region: string | null;
    parentId: number | null;
    hotelCount: number;
}

export interface DestinationResolveResult {
    id: number;
    name: string;
    matchStrategy: MatchStrategy;
    hotelCount: number;
}

/**
 * Run a Prisma destination filter and join hotel counts in a single query.
 * Returns rows with hotelCount, ordered by:
 *   1. hotelCount DESC (most-bookable first)
 *   2. name length ASC (prefer shorter, more-specific names)
 *   3. id ASC (deterministic tie-break)
 *
 * Zero-hotel destinations are NOT excluded — they sort to the bottom of the
 * primary group and remain visible to staff and webhook callers.
 */
async function findRanked(
    where: Prisma.DestinationWhereInput,
    take: number,
): Promise<DestinationSearchRow[]> {
    const dests = await prisma.destination.findMany({
        where,
        select: {
            id: true,
            name: true,
            countryCode: true,
            region: true,
            parentId: true,
        },
        // Pull a generous candidate set so the post-fetch sort can rank by
        // hotel count without a follow-up query per destination. The list is
        // bounded by the WHERE filter so this stays cheap.
        take: take * 5,
    });
    if (dests.length === 0) return [];

    const ids = dests.map((d) => d.id);
    const counts = await prisma.hotel.groupBy({
        by: ['destinationId'],
        where: { destinationId: { in: ids } },
        _count: { _all: true },
    });
    const countByDest = new Map<number, number>();
    for (const c of counts) {
        if (c.destinationId != null) countByDest.set(c.destinationId, c._count._all);
    }

    const rows: DestinationSearchRow[] = dests.map((d) => ({
        id: d.id,
        name: d.name,
        countryCode: d.countryCode,
        region: d.region,
        parentId: d.parentId,
        hotelCount: countByDest.get(d.id) ?? 0,
    }));

    rows.sort((a, b) => {
        if (b.hotelCount !== a.hotelCount) return b.hotelCount - a.hotelCount;
        if (a.name.length !== b.name.length) return a.name.length - b.name.length;
        return a.id - b.id;
    });

    return rows.slice(0, take);
}

export class DestinationRepository {
    /**
     * Search destinations by partial name for the FE dropdown.
     * Match-quality (startsWith vs contains) is applied as a secondary sort
     * within the inventory ranking — most-bookable result still wins overall.
     */
    async searchByName(query: string, limit = 10): Promise<DestinationSearchRow[]> {
        const q = query.trim();
        if (q.length < 2) return [];

        // Single contains query — covers exact, startsWith, and substring matches.
        // We apply match-quality as a secondary sort below.
        const rows = await findRanked(
            { name: { contains: q, mode: 'insensitive' } },
            limit * 3,
        );

        const lower = q.toLowerCase();
        const ranked = rows
            .map((r) => ({
                ...r,
                _starts: r.name.toLowerCase().startsWith(lower) ? 0 : 1,
            }))
            .sort((a, b) => {
                if (b.hotelCount !== a.hotelCount) return b.hotelCount - a.hotelCount;
                if (a._starts !== b._starts) return a._starts - b._starts;
                if (a.name.length !== b.name.length) return a.name.length - b.name.length;
                return a.id - b.id;
            })
            .slice(0, limit)
            .map(({ _starts, ...row }) => row);

        return ranked;
    }

    /**
     * Resolve a single destination name (typically from a customer webhook
     * payload) to one canonical destinationId. Walks four match strategies in
     * order — exact → startsWith → contains → firstWord — and at each tier
     * picks the candidate with the most hotel inventory.
     *
     * Strategy precedence wins over inventory only when the tier produces a
     * candidate with hotels. A zero-inventory match (e.g. "Orlando" id 38646
     * which exists in master data but has no synced hotels) does NOT block the
     * walk — we keep searching later tiers and only fall back to the empty
     * match if nothing populated turns up. This avoids the
     * "Orlando → empty Orlando junk row instead of populated Orlando-FL" bug.
     */
    async resolveByName(name: string): Promise<DestinationResolveResult> {
        const cleaned = name?.trim();
        if (!cleaned) {
            return { id: 0, name, matchStrategy: 'none', hotelCount: 0 };
        }

        const tiers: Array<{ strategy: MatchStrategy; where: Prisma.DestinationWhereInput }> = [
            { strategy: 'exact',      where: { name: { equals: cleaned, mode: 'insensitive' } } },
            { strategy: 'startsWith', where: { name: { startsWith: cleaned, mode: 'insensitive' } } },
            { strategy: 'contains',   where: { name: { contains: cleaned, mode: 'insensitive' } } },
        ];

        // Track the best zero-inventory match we encounter, so if no tier
        // yields a populated result we still return *something* rather than
        // id=0. Earlier tiers (more specific) take precedence here.
        let zeroFallback: DestinationResolveResult | null = null;

        for (const tier of tiers) {
            // Pull a few candidates per tier so we don't miss a populated row
            // hiding behind a same-tier zero-inventory junk entry.
            const rows = await findRanked(tier.where, 5);
            if (rows.length === 0) continue;

            // findRanked already sorts by hotelCount desc, so rows[0] is the
            // best candidate at this tier. If it has hotels, take it.
            const top = rows[0]!;
            if (top.hotelCount > 0) {
                return {
                    id: top.id,
                    name: top.name,
                    matchStrategy: tier.strategy,
                    hotelCount: top.hotelCount,
                };
            }

            // Tier produced ONLY zero-inventory rows — remember the most
            // specific zero match (first tier wins) and keep walking.
            if (!zeroFallback) {
                zeroFallback = {
                    id: top.id,
                    name: top.name,
                    matchStrategy: tier.strategy,
                    hotelCount: 0,
                };
            }
        }

        // Fallback: try the first word of the input, only if it differs from
        // the full input (otherwise we'd repeat the contains tier above).
        const firstWord = cleaned.split(/\s+/)[0];
        if (firstWord && firstWord !== cleaned) {
            const rows = await findRanked(
                { name: { contains: firstWord, mode: 'insensitive' } },
                5,
            );
            if (rows.length > 0) {
                const top = rows[0]!;
                if (top.hotelCount > 0) {
                    return {
                        id: top.id,
                        name: top.name,
                        matchStrategy: 'firstWord',
                        hotelCount: top.hotelCount,
                    };
                }
                if (!zeroFallback) {
                    zeroFallback = {
                        id: top.id,
                        name: top.name,
                        matchStrategy: 'firstWord',
                        hotelCount: 0,
                    };
                }
            }
        }

        // No populated match anywhere — return the most specific zero match if
        // we saw one. Webhook caller logs a warning when hotelCount===0 so
        // staff still see the request needs attention.
        if (zeroFallback) return zeroFallback;

        return { id: 0, name: cleaned, matchStrategy: 'none', hotelCount: 0 };
    }
}

export default new DestinationRepository();

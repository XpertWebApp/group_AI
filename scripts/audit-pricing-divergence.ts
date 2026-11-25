/**
 * audit-pricing-divergence.ts
 *
 * Scans every ProposalHotel row in the database and reports how many
 * have persisted `sell` prices that DIFFER from what Oliver's Option A
 * rule (ceil + price-psychology) would compute from the same net rate.
 *
 * Context: until Shamandeep's Option A change, the FE persisted a
 * cents-precision recomputed value. From now on (2026-08-08 onwards)
 * the FE persists the backend's whole-euro `sellPricePerRoomPerNight`
 * verbatim. This script tells us how much historical drift exists.
 *
 * Read-only. Does not modify any data.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/audit-pricing-divergence.ts
 *
 * Output:
 *   Summary counts + a sample of the biggest divergences by absolute
 *   euro amount, so we can eyeball whether historical offers need any
 *   action or the drift is trivial.
 */

import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

function applyOptionA(net: number, markupPercent: number): number {
    const raw = net * (1 + markupPercent / 100);
    const ceil = Math.ceil(raw);
    if (ceil % 10 === 0) return ceil - 2;
    if (ceil % 5 === 0) return ceil - 1;
    return ceil;
}

interface DivergenceRow {
    proposalRef: number | null;
    hotelName: string;
    roomType: string;
    net: number;
    persistedSell: number;
    optionASell: number;
    delta: number;
    qty: number;
    nights: number;
    totalDelta: number;
    createdAt: Date;
}

async function main(): Promise<number> {
    const prisma = new PrismaClient();

    try {
        console.log('\n🔍 Scanning all ProposalHotel rows for pricing divergence…\n');

        // Read the current default markup from settings so the recomputation
        // matches what the FE would have used at persist time. For older
        // proposals whose markup at the moment of creation might have been
        // different, this can slightly overstate the divergence — flagged
        // as a caveat below.
        const settingsRow: any = await prisma.$queryRawUnsafe(
            `SELECT value FROM app.settings WHERE key = 'defaultMarkupPercentage' LIMIT 1`,
        );
        const currentMarkup = settingsRow?.[0]?.value
            ? Number(settingsRow[0].value)
            : 18;
        console.log(`Using markup: ${currentMarkup}% (current Settings value)\n`);

        // Load every ProposalHotel row that has a rooms JSON. We iterate
        // in Node rather than SQL because the JSON structure is per-row
        // and Prisma's JSON filters don't cover the arithmetic we need.
        const hotels: any[] = await prisma.$queryRawUnsafe(`
            SELECT
              ph.id,
              ph.hotel_name,
              ph.rooms,
              ph.created_at,
              br.reference_number
            FROM app.proposal_hotels ph
            LEFT JOIN app.proposals p ON p.id = ph.proposal_id
            LEFT JOIN app.booking_requests br ON br.id = p.request_id
            WHERE ph.rooms IS NOT NULL
              AND ph.deleted_at IS NULL
            ORDER BY ph.created_at DESC
        `);

        console.log(`Scanned ${hotels.length} ProposalHotel rows.\n`);

        const divergent: DivergenceRow[] = [];
        let matching = 0;
        let noNet = 0;
        let scannedRoomEntries = 0;

        for (const h of hotels) {
            const rooms = h.rooms as Record<string, any>;
            if (!rooms || typeof rooms !== 'object') continue;

            for (const [roomType, detail] of Object.entries(rooms)) {
                if (!detail || typeof detail !== 'object') continue;
                const net = Number((detail as any).net ?? 0);
                const persistedSell = Number((detail as any).sell ?? 0);
                const qty = Number((detail as any).qty ?? 0);
                const nights = Number((detail as any).nights ?? 0);

                if (net <= 0 || persistedSell <= 0) {
                    noNet++;
                    continue;
                }
                scannedRoomEntries++;

                const optionASell = applyOptionA(net, currentMarkup);
                const delta = optionASell - persistedSell;

                if (Math.abs(delta) < 0.005) {
                    matching++;
                    continue;
                }

                divergent.push({
                    proposalRef: h.reference_number ?? null,
                    hotelName: h.hotel_name ?? '(unknown)',
                    roomType,
                    net,
                    persistedSell,
                    optionASell,
                    delta,
                    qty,
                    nights,
                    totalDelta: delta * qty * (nights || 1),
                    createdAt: new Date(h.created_at),
                });
            }
        }

        console.log('─'.repeat(60));
        console.log('SUMMARY');
        console.log('─'.repeat(60));
        console.log(`  Room entries scanned:              ${scannedRoomEntries}`);
        console.log(`  Matching Option A exactly:         ${matching}`);
        console.log(`  Divergent from Option A:           ${divergent.length}`);
        console.log(`  Skipped (missing net or sell):     ${noNet}`);
        if (scannedRoomEntries > 0) {
            const pct = ((divergent.length / scannedRoomEntries) * 100).toFixed(1);
            console.log(`  Divergence rate:                   ${pct}%`);
        }

        if (divergent.length === 0) {
            console.log('\n✅ Zero divergence. All existing offers match Option A.\n');
            return 0;
        }

        // Aggregate by absolute total delta so the biggest financial gaps
        // surface first — those are the ones worth eyeballing manually.
        divergent.sort((a, b) => Math.abs(b.totalDelta) - Math.abs(a.totalDelta));

        const totalAbsoluteDrift = divergent.reduce(
            (s, r) => s + Math.abs(r.totalDelta),
            0,
        );
        const totalSignedDrift = divergent.reduce((s, r) => s + r.totalDelta, 0);

        console.log('\n─'.repeat(60));
        console.log('FINANCIAL IMPACT');
        console.log('─'.repeat(60));
        console.log(`  Total absolute drift (|delta|):    €${totalAbsoluteDrift.toFixed(2)}`);
        console.log(`  Total signed drift (Option A − persisted): €${totalSignedDrift.toFixed(2)}`);
        console.log(`    (positive = persisted UNDERCHARGES vs Option A; negative = persisted OVERCHARGES)`);

        console.log('\n─'.repeat(60));
        console.log(`TOP 15 DIVERGENT ROOM-TYPE ENTRIES (by |total delta|)`);
        console.log('─'.repeat(60));
        console.log(
            'Ref#  Hotel                    Type              Net       Sell(persisted) Sell(A)   Δ/night   Total Δ    Created',
        );
        for (const r of divergent.slice(0, 15)) {
            console.log(
                (r.proposalRef ? '#' + r.proposalRef : '?').padEnd(6),
                r.hotelName.slice(0, 24).padEnd(25),
                r.roomType.slice(0, 17).padEnd(18),
                r.net.toFixed(2).padStart(8),
                r.persistedSell.toFixed(2).padStart(15),
                r.optionASell.toFixed(2).padStart(9),
                r.delta.toFixed(2).padStart(9),
                r.totalDelta.toFixed(2).padStart(10),
                r.createdAt.toISOString().slice(0, 10),
            );
        }

        // Bucket by size so we can see the shape of the drift.
        const buckets = { under1: 0, under5: 0, under20: 0, over20: 0 };
        for (const r of divergent) {
            const abs = Math.abs(r.totalDelta);
            if (abs < 1) buckets.under1++;
            else if (abs < 5) buckets.under5++;
            else if (abs < 20) buckets.under20++;
            else buckets.over20++;
        }
        console.log('\n─'.repeat(60));
        console.log('DIVERGENCE DISTRIBUTION (per room-type entry, total euro impact)');
        console.log('─'.repeat(60));
        console.log(`  |Δ| <  €1:     ${buckets.under1.toString().padStart(6)}  (negligible, ignore)`);
        console.log(`  €1  ≤ |Δ| < €5:  ${buckets.under5.toString().padStart(6)}  (small)`);
        console.log(`  €5  ≤ |Δ| < €20: ${buckets.under20.toString().padStart(6)}  (worth a look)`);
        console.log(`  |Δ| ≥ €20:     ${buckets.over20.toString().padStart(6)}  (material — review manually)`);

        console.log('\n─'.repeat(60));
        console.log('CAVEAT');
        console.log('─'.repeat(60));
        console.log(
            `  This audit uses the CURRENT Settings markup (${currentMarkup}%). If markup changed`,
        );
        console.log(
            `  historically (e.g. it used to be 22.5%, now it's ${currentMarkup}%), older`,
        );
        console.log(
            `  entries will show as divergent even if they matched Option A at the time`,
        );
        console.log(
            `  they were created. Treat the totals as an upper bound, not a hard number.`,
        );

        console.log('');
        return 0;
    } catch (err) {
        console.error('\n❌ Audit failed:', err instanceof Error ? err.message : err);
        return 1;
    } finally {
        await prisma.$disconnect();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });

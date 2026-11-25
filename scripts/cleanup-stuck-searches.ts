/**
 * cleanup-stuck-searches.ts
 *
 * Bulk-marks stuck hotel searches as `needs_manual_handling` so the
 * frontend stops polling forever and the admin can trigger a fresh
 * search. Safe to run repeatedly — idempotent.
 *
 * What "stuck" means here:
 *   - BookingRequest.search_phase = 'in_progress'
 *   - AND updated_at older than the threshold (default 10 minutes)
 *
 * We also mark all the request's queued probe jobs as FAILED so the
 * status/summary endpoint shows a consistent picture (no dangling
 * QUEUED rows on a request that we've given up on).
 *
 * Usage (from the sett_be directory on the live server):
 *
 *   # Dry-run — print what WOULD be cleaned up, don't touch anything:
 *   npx ts-node scripts/cleanup-stuck-searches.ts
 *
 *   # Actually clean up (adds --apply flag):
 *   npx ts-node scripts/cleanup-stuck-searches.ts --apply
 *
 *   # Change the "stuck" threshold (default 10 minutes):
 *   npx ts-node scripts/cleanup-stuck-searches.ts --apply --minutes 5
 *
 *   # Clean up only a specific reference number:
 *   npx ts-node scripts/cleanup-stuck-searches.ts --apply --ref 310
 *
 * Exit codes:
 *   0 = ran successfully (nothing to clean up is still 0)
 *   1 = arg error / DB error
 *
 * Requires DATABASE_URL in .env. No sudo needed.
 */

import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

async function main(): Promise<number> {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');

    const minutesIdx = args.indexOf('--minutes');
    const minutes = minutesIdx >= 0 ? Number(args[minutesIdx + 1]) : 10;
    if (!Number.isFinite(minutes) || minutes <= 0) {
        console.error('❌ --minutes must be a positive number');
        return 1;
    }

    const refIdx = args.indexOf('--ref');
    const refNumber = refIdx >= 0 ? Number(args[refIdx + 1]) : null;
    if (refIdx >= 0 && (!Number.isFinite(refNumber!) || refNumber! <= 0)) {
        console.error('❌ --ref must be a positive integer reference number');
        return 1;
    }

    const prisma = new PrismaClient();

    try {
        console.log(`\n${apply ? '🔧 APPLY MODE' : '👀 DRY-RUN MODE (add --apply to actually run)'}`);
        console.log(`Threshold: search stuck for more than ${minutes} minute(s)`);
        if (refNumber) console.log(`Scope: ONLY reference number ${refNumber}`);
        console.log('─'.repeat(60));

        // 1. Find the stuck requests
        const stuckRequests: any = refNumber
            ? await prisma.$queryRawUnsafe(
                `SELECT id, reference_number, destination_name, checkin_date, updated_at
                 FROM app.booking_requests
                 WHERE search_phase = 'in_progress'
                   AND reference_number = ${refNumber}`,
              )
            : await prisma.$queryRawUnsafe(
                `SELECT id, reference_number, destination_name, checkin_date, updated_at
                 FROM app.booking_requests
                 WHERE search_phase = 'in_progress'
                   AND updated_at < NOW() - INTERVAL '${minutes} minutes'
                 ORDER BY updated_at ASC`,
              );

        if (stuckRequests.length === 0) {
            console.log('\n✅ No stuck searches found. Nothing to do.\n');
            return 0;
        }

        console.log(`\nFound ${stuckRequests.length} stuck request(s):\n`);
        console.log(
            'Ref#'.padEnd(8),
            'Destination'.padEnd(20),
            'Check-in'.padEnd(12),
            'Stuck since',
        );
        for (const r of stuckRequests) {
            console.log(
                String(r.reference_number).padEnd(8),
                String(r.destination_name).slice(0, 19).padEnd(20),
                new Date(r.checkin_date).toISOString().slice(0, 10).padEnd(12),
                new Date(r.updated_at).toISOString(),
            );
        }

        // 2. Count how many probe jobs would be cleaned up too
        const ids = stuckRequests.map((r: any) => r.id);
        const jobCountRows: any = await prisma.$queryRawUnsafe(`
            SELECT COUNT(*)::int AS c
            FROM app.hotel_probe_jobs
            WHERE search_request_id IN (${ids.map((id: string) => `'${id}'`).join(',')})
              AND status IN ('QUEUED', 'RUNNING', 'PROBING')
        `);
        const jobCount = jobCountRows?.[0]?.c ?? 0;
        console.log(
            `\n${stuckRequests.length} request(s) will be marked as 'needs_manual_handling'.`,
        );
        console.log(
            `${jobCount} probe job(s) currently QUEUED / RUNNING / PROBING will be marked as FAILED.`,
        );

        if (!apply) {
            console.log(
                `\n👀 Dry-run only. No changes made. Re-run with --apply to actually clean up.\n`,
            );
            return 0;
        }

        // 3. Apply the cleanup
        console.log('\n🔧 Applying cleanup...\n');

        const idsInClause = ids.map((id: string) => `'${id}'`).join(',');

        // 3a. Mark requests as needs_manual_handling
        const reqResult: any = await prisma.$executeRawUnsafe(`
            UPDATE app.booking_requests
            SET search_phase = 'exhausted',
                status = 'needs_manual_handling',
                updated_at = NOW()
            WHERE id IN (${idsInClause})
        `);
        console.log(`✅ Updated ${reqResult} booking_request row(s)`);

        // 3b. Mark associated queued/running jobs as FAILED so the status
        //     endpoint doesn't show dangling QUEUED rows on a dead request.
        const jobResult: any = await prisma.$executeRawUnsafe(`
            UPDATE app.hotel_probe_jobs
            SET status = 'FAILED',
                error_msg = 'Bulk cleanup: search was stuck >${minutes} minutes',
                completed_at = NOW()
            WHERE search_request_id IN (${idsInClause})
              AND status IN ('QUEUED', 'RUNNING', 'PROBING')
        `);
        console.log(`✅ Failed ${jobResult} probe job(s)\n`);

        console.log('Done. Users can now create fresh search requests.');
        console.log(
            'Recommend also checking /health/deep to confirm the worker is currently connected.\n',
        );
        return 0;
    } catch (err) {
        console.error('\n❌ Cleanup script failed:', err instanceof Error ? err.message : err);
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

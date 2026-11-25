/**
 * Cancels certification test bookings that are still open.
 *
 * A confirmed booking that is never cancelled is charged at its cancellation
 * deadline, so any refundable test reservation left behind by an interrupted
 * run is a real cost. This is the safety net for that case: it finds every
 * refundable certification booking still in `booked` or `vouchered` and
 * cancels it.
 *
 * Nonrefundable bookings are never touched — cancelling one incurs a charge
 * rather than avoiding one, so those are reported and left alone.
 *
 * Usage:
 *   npx tsx scripts/certification/cleanup.ts           # list what would be cancelled
 *   npx tsx scripts/certification/cleanup.ts --confirm # actually cancel
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bookingRepository from '../../src/repositories/booking.repository';
import wbeBookingService from '../../src/services/wbeBooking.service';

const prisma = new PrismaClient();

async function main() {
    const confirm = process.argv.includes('--confirm');

    const open = await bookingRepository.findCertificationBookingsToCancel();

    const nonRefundable = await prisma.booking.findMany({
        where: {
            isCertificationTest: true,
            nonRefundable: true,
            status: { in: ['booked', 'vouchered'] },
        },
        select: { certificationScenario: true, bookingReference: true, status: true },
    });

    console.log('\n\x1b[1mCertification booking cleanup\x1b[0m');
    console.log(`Mode: ${confirm ? '\x1b[31mLIVE — bookings will be cancelled\x1b[0m' : '\x1b[32mPREVIEW — nothing will change\x1b[0m'}\n`);

    if (nonRefundable.length > 0) {
        console.log('\x1b[33mNonrefundable bookings (left untouched — cancelling would incur a charge):\x1b[0m');
        nonRefundable.forEach((b) =>
            console.log(`  Scenario ${b.certificationScenario}: ${b.bookingReference} [${b.status}]`),
        );
        console.log();
    }

    if (open.length === 0) {
        console.log('No refundable certification bookings are open. Nothing to do.');
        await prisma.$disconnect();
        return;
    }

    console.log(`Refundable bookings still open: ${open.length}`);
    open.forEach((b) =>
        console.log(
            `  Scenario ${b.certificationScenario ?? '—'}: ${b.bookingReference}` +
            ` [${b.status}]` +
            (b.cancellationDeadline ? ` deadline ${b.cancellationDeadline.toISOString().slice(0, 10)}` : ''),
        ),
    );

    if (!confirm) {
        console.log('\nRe-run with --confirm to cancel these.');
        await prisma.$disconnect();
        return;
    }

    console.log('\nCancelling…');
    let cancelled = 0;
    let failed = 0;

    for (const booking of open) {
        try {
            const result = await wbeBookingService.cancel(booking.id);
            if (result.status === 'cancelled') {
                console.log(`  \x1b[32m✓\x1b[0m ${booking.bookingReference} — cancelled (charge: ${result.cancellationCharge ?? 0})`);
                cancelled++;
            } else {
                // PNDC: WBE could not settle it and a human must confirm.
                console.log(`  \x1b[33m!\x1b[0m ${booking.bookingReference} — pending manual confirmation at WBE`);
                cancelled++;
            }
        } catch (err: any) {
            console.log(`  \x1b[31m✗\x1b[0m ${booking.bookingReference} — ${err.message}`);
            failed++;
        }
    }

    console.log(`\nCancelled: ${cancelled} | Failed: ${failed}`);
    if (failed > 0) {
        console.log('\x1b[33mFailed cancellations must be handled manually in the WBE back office before their deadline.\x1b[0m');
    }

    await prisma.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
    console.error('Cleanup crashed:', err);
    await prisma.$disconnect();
    process.exit(1);
});

import { PrismaClient } from '@prisma/client';

import notificationService, { resolveStaffNotificationEmail } from './notification.service';
import logger from '../utils/logger';

const prisma = new PrismaClient();

/**
 * Tells staff a search has stalled, before a customer has to.
 *
 * On 6 August a search sat at "0 of 87 hotels checked" for two hours. Nothing
 * raised it — the condition was visible in the database and on /health/deep the
 * whole time, but nobody was looking, so the first report came from the client.
 *
 * This closes that loop. It does not diagnose the cause; it says a search has
 * stopped moving and names it, which is the part that was missing.
 */

/**
 * How long a search may sit in `in_progress` without finishing before it counts
 * as stalled.
 *
 * Fifteen minutes is past any legitimate run. A large search takes a few
 * minutes — the e2e suite measured 657s for 200 jobs — so this leaves room for
 * a slow one without waiting so long that a customer notices first.
 */
export const STALL_THRESHOLD_MS = Number(
    process.env['SEARCH_STALL_ALERT_MINUTES'] ?? 15,
) * 60_000;

/**
 * Minimum gap between alerts about the same search.
 *
 * The check runs every minute; without this, one stalled search would send an
 * alert every minute until someone acted on it. An inbox full of the same
 * message is how alerts get ignored.
 */
const REALERT_INTERVAL_MS = 60 * 60_000;

/** requestId → when we last alerted about it. Process-local by design. */
const lastAlertedAt = new Map<string, number>();

export interface StalledSearch {
    requestId: string;
    referenceNumber: number;
    destinationName: string | null;
    stalledForMinutes: number;
    jobsTotal: number;
    jobsDone: number;
}

export class SearchHealthAlertService {
    /**
     * Find searches that have stopped making progress.
     *
     * Reports rather than fixes. The watchdogs settle the jobs; this exists so
     * a person hears about it.
     */
    async findStalledSearches(): Promise<StalledSearch[]> {
        const cutoff = new Date(Date.now() - STALL_THRESHOLD_MS);

        const rows = await prisma.$queryRawUnsafe<
            Array<{
                id: string;
                reference_number: number;
                destination_name: string | null;
                updated_at: Date;
                jobs_total: bigint;
                jobs_done: bigint;
            }>
        >(
            `
            SELECT br.id, br.reference_number, br.destination_name, br.updated_at,
                   COUNT(j.id) AS jobs_total,
                   COUNT(j.id) FILTER (
                       WHERE j.status IN ('COMPLETED', 'FAILED', 'SKIPPED_INSUFFICIENT')
                   ) AS jobs_done
            FROM app.booking_requests br
            LEFT JOIN app.hotel_probe_jobs j ON j.search_request_id = br.id
            WHERE br.search_phase = 'in_progress'
              AND br.updated_at < $1
            GROUP BY br.id, br.reference_number, br.destination_name, br.updated_at
            `,
            cutoff,
        );

        return rows.map((r) => ({
            requestId: r.id,
            referenceNumber: r.reference_number,
            destinationName: r.destination_name,
            stalledForMinutes: Math.round((Date.now() - r.updated_at.getTime()) / 60_000),
            jobsTotal: Number(r.jobs_total),
            jobsDone: Number(r.jobs_done),
        }));
    }

    /**
     * Check for stalled searches and alert on any that are new.
     *
     * Called on a timer. Returns how many alerts were sent, which is zero on
     * the overwhelming majority of runs.
     */
    async checkAndAlert(): Promise<number> {
        let sent = 0;

        let stalled: StalledSearch[];
        try {
            stalled = await this.findStalledSearches();
        } catch (err: any) {
            // A failing check must not take the server down with it — but it
            // does mean we are blind again, so it is logged as an error.
            logger.error({ msg: 'Stalled-search check failed', error: err.message });
            return 0;
        }

        if (stalled.length === 0) {
            // Forget searches that have since resolved, so a later stall on the
            // same request alerts immediately rather than being throttled by a
            // stale entry.
            lastAlertedAt.clear();
            return 0;
        }

        const staffEmail = resolveStaffNotificationEmail();

        for (const search of stalled) {
            const last = lastAlertedAt.get(search.requestId) ?? 0;
            if (Date.now() - last < REALERT_INTERVAL_MS) continue;

            try {
                await this.alert(search, staffEmail);
                lastAlertedAt.set(search.requestId, Date.now());
                sent++;
            } catch (err: any) {
                logger.error({
                    msg: 'Could not send stalled-search alert',
                    requestId: search.requestId,
                    error: err.message,
                });
            }
        }

        // Logged whether or not an alert went out, so the condition is visible
        // in the logs even if email is misconfigured.
        logger.error(
            {
                stalledSearches: stalled.length,
                alertsSent: sent,
                searches: stalled.map((s) => ({
                    ref: s.referenceNumber,
                    minutes: s.stalledForMinutes,
                    progress: `${s.jobsDone}/${s.jobsTotal}`,
                })),
            },
            'Searches have stalled — customers are watching a progress bar that is not moving',
        );

        return sent;
    }

    private async alert(search: StalledSearch, staffEmail: string): Promise<void> {
        const progress =
            search.jobsTotal > 0
                ? `${search.jobsDone} of ${search.jobsTotal} hotels checked`
                : 'no probe jobs were created';

        const title = `Search stalled — request #${search.referenceNumber}`;
        const message =
            `The hotel search for #${search.referenceNumber}` +
            `${search.destinationName ? ` (${search.destinationName})` : ''} ` +
            `has not progressed for ${search.stalledForMinutes} minutes — ${progress}. ` +
            `The customer sees a progress bar that is not moving. ` +
            `Check /health/deep for the worker and RabbitMQ status.`;

        await notificationService.notify({
            type: 'search_stalled',
            title,
            message,
            entityId: search.requestId,
            entityType: 'booking_request',
            email: staffEmail
                ? {
                      eventType: 'search_stalled',
                      to: staffEmail,
                      subject: title,
                      html: `<p>${message}</p>`,
                  }
                : undefined,
        });
    }
}

export default new SearchHealthAlertService();

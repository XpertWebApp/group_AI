import { getChannel, HOTEL_PROBE_QUEUE } from './rabbitmq.client';
import { HotelProbeJobPayload } from './hotelProbeJob.types';
import logger from '../utils/logger';

/**
 * Put one probe job on the queue.
 *
 * Returns whether the job reached RabbitMQ. Callers use this to tell the
 * difference between "the search is running" and "the search will never
 * start" — a distinction that was invisible during the 6 August incident,
 * where 87 jobs sat QUEUED for two hours and the only signal was a progress
 * bar frozen at zero.
 */
export async function publishHotelProbeJob(
    payload: HotelProbeJobPayload,
): Promise<boolean> {
    const ch = await getChannel();
    if (!ch) {
        logger.error(
            { jobId: payload.jobId, hotelCode: payload.hotelCode, queue: HOTEL_PROBE_QUEUE },
            'Probe job NOT published — no RabbitMQ channel. This search cannot start.',
        );
        return false;
    }

    // sendToQueue returns false when the channel's write buffer is full. The
    // message is still queued in memory and flushed on 'drain', but a caller
    // that ignores this cannot tell a slow publish from a lost one — and a
    // process restart before the drain loses it silently.
    const accepted = ch.sendToQueue(
        HOTEL_PROBE_QUEUE,
        Buffer.from(JSON.stringify(payload)),
        { persistent: true },
    );

    if (!accepted) {
        logger.warn(
            { jobId: payload.jobId, hotelCode: payload.hotelCode },
            'Probe job buffered — RabbitMQ write buffer full, publish is behind',
        );
    }

    return true;
}

/**
 * Confirm how many of a search's jobs actually reached the queue.
 *
 * Logged at info because it is the first thing worth knowing when a search is
 * reported stuck: a count below the expected total means the jobs were never
 * dispatched, and no amount of worker debugging will explain it.
 */
export function logPublishSummary(
    searchRequestId: string,
    published: number,
    expected: number,
): void {
    if (published === expected) {
        logger.info(
            { searchRequestId, jobs: published, queue: HOTEL_PROBE_QUEUE },
            'Probe jobs published — search dispatched',
        );
        return;
    }

    logger.error(
        { searchRequestId, published, expected, missing: expected - published },
        'Probe jobs only partly published — this search will stall',
    );
}

import { getChannel, HOTEL_PROBE_QUEUE } from './rabbitmq.client';
import { HotelProbeJobPayload } from './hotelProbeJob.types';
import logger from '../utils/logger';

export async function publishHotelProbeJob(payload: HotelProbeJobPayload): Promise<void> {
    const ch = await getChannel();
    ch.sendToQueue(
        HOTEL_PROBE_QUEUE,
        Buffer.from(JSON.stringify(payload)),
        { persistent: true },
    );
    logger.debug({ jobId: payload.jobId, hotelCode: payload.hotelCode }, 'HotelProbeJob published');
}

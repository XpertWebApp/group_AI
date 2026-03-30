import * as amqp from 'amqplib';
import logger from '../utils/logger';
import { WORKER_JOB_CONCURRENCY } from '../config/probeConfig';

export const HOTEL_PROBE_QUEUE = 'hotel_probe_jobs';

let model: amqp.ChannelModel | null = null;
let channel: amqp.Channel | null = null;

async function connect(): Promise<amqp.Channel | null> {
    const url = process.env.RABBITMQ_URL ?? 'amqp://localhost';
    try {
        model = await amqp.connect(url);
    } catch (err) {
        logger.warn({ msg: 'RabbitMQ not available — worker features disabled', error: err instanceof Error ? err.message : String(err) });
        return null;
    }

    model.on('error', (err: unknown) => {
        logger.error({ msg: 'RabbitMQ connection error', error: err instanceof Error ? err.message : String(err) });
        channel = null;
        model = null;
    });

    model.on('close', () => {
        logger.warn('RabbitMQ connection closed');
        channel = null;
        model = null;
    });

    channel = await model.createChannel();
    await channel.assertQueue(HOTEL_PROBE_QUEUE, { durable: true });
    channel.prefetch(WORKER_JOB_CONCURRENCY);

    logger.info('RabbitMQ channel ready');
    return channel;
}

export async function getChannel(): Promise<amqp.Channel | null> {
    if (!channel) {
        return connect();
    }
    return channel;
}

export async function closeConnection(): Promise<void> {
    try {
        if (channel) await channel.close();
        if (model) await model.close();
    } catch {
        // ignore errors on close
    } finally {
        channel = null;
        model = null;
    }
}

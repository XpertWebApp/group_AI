import * as amqp from 'amqplib';
import logger from '../utils/logger';
import { WORKER_JOB_CONCURRENCY } from '../config/probeConfig';

export const HOTEL_PROBE_QUEUE = 'hotel_probe_jobs';

// ─── Connection state ─────────────────────────────────────────────────────────
let model: amqp.ChannelModel | null = null;
let channel: amqp.Channel | null = null;

// Track whether we're currently trying to reconnect so multiple event handlers
// firing at once (both 'error' AND 'close' can fire on one drop) don't spawn
// parallel reconnect loops. Guarded by a simple boolean flag; the reconnect
// coroutine sets it to true while it's running and clears it on completion.
let reconnecting = false;

// Track the last successful connect timestamp so we can implement exponential
// backoff — successive rapid drops back off more aggressively than isolated
// ones. Reset to 0 (i.e. "long ago") on every successful connect.
let lastSuccessfulConnectAt = 0;

// Backoff schedule (ms). We start fast to recover quickly from transient
// hiccups, then slow down to avoid hammering a truly-down broker. Capped at
// 2 minutes so a long RabbitMQ outage doesn't compound into hours between
// retry attempts.
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000, 120000];

// Callbacks invoked after every successful (re)connect so callers can
// re-register their consumers. `startHotelProbeWorker` registers itself via
// `onReconnect()` at boot; after a drop → reconnect cycle, we call it again
// so the ch.consume() call is re-issued on the fresh channel.
const reconnectCallbacks: Array<() => Promise<void> | void> = [];

/**
 * Register a callback that should run after every successful reconnect
 * (including the very first connect). Use this to re-register consumers
 * on the fresh channel — without this, a channel drop leaves the queue
 * running with zero consumers and every subsequent search silently
 * stuck in QUEUED state forever.
 *
 * Called once from `startHotelProbeWorker` — do NOT register the same
 * callback twice from different code paths, it will double-consume
 * every message.
 */
export function onReconnect(cb: () => Promise<void> | void): void {
    reconnectCallbacks.push(cb);
}

// ─── Core connect logic ──────────────────────────────────────────────────────

async function attemptConnect(): Promise<amqp.Channel | null> {
    const url = process.env.RABBITMQ_URL ?? 'amqp://localhost';

    let newModel: amqp.ChannelModel;
    try {
        newModel = await amqp.connect(url);
    } catch (err) {
        logger.warn({
            msg: 'RabbitMQ connect failed',
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }

    // Attach error/close handlers BEFORE creating the channel so a drop
    // during channel creation still triggers our reconnect flow.
    newModel.on('error', (err: unknown) => {
        logger.error({
            msg: 'RabbitMQ connection error — will reconnect',
            error: err instanceof Error ? err.message : String(err),
        });
        handleDrop();
    });

    newModel.on('close', () => {
        logger.warn('RabbitMQ connection closed — will reconnect');
        handleDrop();
    });

    let newChannel: amqp.Channel;
    try {
        newChannel = await newModel.createChannel();
        await newChannel.assertQueue(HOTEL_PROBE_QUEUE, { durable: true });
        newChannel.prefetch(WORKER_JOB_CONCURRENCY);
    } catch (err) {
        // Channel setup failed — tear down the model and let the reconnect
        // loop retry from scratch. Without this, we'd leak an open
        // connection with no working channel.
        try { await newModel.close(); } catch { /* best effort */ }
        logger.error({
            msg: 'RabbitMQ channel setup failed',
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }

    // Same idea on the channel — if the channel dies mid-operation, treat
    // it as a full-connection drop so we re-establish everything.
    newChannel.on('error', (err: unknown) => {
        logger.error({
            msg: 'RabbitMQ channel error — will reconnect',
            error: err instanceof Error ? err.message : String(err),
        });
        handleDrop();
    });

    newChannel.on('close', () => {
        logger.warn('RabbitMQ channel closed — will reconnect');
        handleDrop();
    });

    // Commit the new state atomically now that both model + channel are ready.
    model = newModel;
    channel = newChannel;
    lastSuccessfulConnectAt = Date.now();

    logger.info('RabbitMQ channel ready');
    return newChannel;
}

/**
 * Called from every error/close handler above. Guards against multiple
 * concurrent reconnect attempts using the `reconnecting` flag. Runs the
 * reconnect loop in the background — never blocks the caller.
 */
function handleDrop(): void {
    channel = null;
    model = null;

    if (reconnecting) return;
    reconnecting = true;

    // Fire and forget — reconnect runs on its own timer, doesn't block.
    reconnectLoop()
        .catch((err) => {
            logger.error({
                msg: 'Reconnect loop crashed (should never happen)',
                error: err instanceof Error ? err.message : String(err),
            });
        })
        .finally(() => {
            reconnecting = false;
        });
}

async function reconnectLoop(): Promise<void> {
    // On rapid successive drops, back off further into the schedule. When
    // the last connect was recent (< 60s ago) we assume the broker is
    // flaky and start higher in the backoff array; otherwise start at
    // the top for a fast recovery on isolated hiccups.
    const rapid = Date.now() - lastSuccessfulConnectAt < 60_000;
    let attempt = rapid ? 2 : 0;

    for (;;) {
        const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]!;
        logger.info({ attempt: attempt + 1, delayMs: delay }, 'RabbitMQ reconnect scheduled');
        await new Promise((r) => setTimeout(r, delay));

        const ch = await attemptConnect();
        if (ch) {
            logger.info({ attempts: attempt + 1 }, 'RabbitMQ reconnected');
            // Re-register consumers. Any callback throw is logged but
            // does not abort the loop — one bad consumer shouldn't take
            // down the whole recovery.
            for (const cb of reconnectCallbacks) {
                try {
                    await cb();
                } catch (err) {
                    logger.error({
                        msg: 'onReconnect callback failed',
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
            return;
        }
        attempt++;
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the current channel, opening a new connection if none exists yet.
 * After a drop, this will return null while the reconnect loop is running
 * — callers should handle that (e.g. skip the publish and let the caller
 * retry, or return an error to the API layer).
 */
export async function getChannel(): Promise<amqp.Channel | null> {
    if (channel) return channel;
    // First-ever connect (server boot). Not going through the reconnect
    // loop so it fails fast on genuine misconfiguration.
    const ch = await attemptConnect();
    return ch;
}

/**
 * Returns true if we currently have a working channel to RabbitMQ. Used by
 * the /health endpoint to detect worker-consumer-dead states.
 */
export function isConnected(): boolean {
    return channel !== null;
}

/**
 * Returns a shallow diagnostic snapshot for /health. Never throws.
 */
export function getConnectionStatus(): {
    connected: boolean;
    reconnecting: boolean;
    lastSuccessfulConnectAt: number | null;
} {
    return {
        connected: channel !== null,
        reconnecting,
        lastSuccessfulConnectAt: lastSuccessfulConnectAt === 0 ? null : lastSuccessfulConnectAt,
    };
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

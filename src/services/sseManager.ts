import { Response } from 'express';

/** Map of searchRequestId → set of connected SSE response streams. */
const clients = new Map<string, Set<Response>>();

export function subscribe(searchRequestId: string, res: Response): void {
    if (!clients.has(searchRequestId)) {
        clients.set(searchRequestId, new Set());
    }
    clients.get(searchRequestId)!.add(res);
    res.on('close', () => {
        clients.get(searchRequestId)?.delete(res);
    });
}

export function broadcast(searchRequestId: string, event: string, data: unknown): void {
    const subs = clients.get(searchRequestId);
    if (!subs || subs.size === 0) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of subs) {
        res.write(msg);
    }
}

export function subscriberCount(searchRequestId: string): number {
    return clients.get(searchRequestId)?.size ?? 0;
}

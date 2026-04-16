"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subscribe = subscribe;
exports.broadcast = broadcast;
exports.subscriberCount = subscriberCount;
/** Map of searchRequestId → set of connected SSE response streams. */
const clients = new Map();
function subscribe(searchRequestId, res) {
    if (!clients.has(searchRequestId)) {
        clients.set(searchRequestId, new Set());
    }
    clients.get(searchRequestId).add(res);
    res.on('close', () => {
        clients.get(searchRequestId)?.delete(res);
    });
}
function broadcast(searchRequestId, event, data) {
    const subs = clients.get(searchRequestId);
    if (!subs || subs.size === 0)
        return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of subs) {
        res.write(msg);
    }
}
function subscriberCount(searchRequestId) {
    return clients.get(searchRequestId)?.size ?? 0;
}

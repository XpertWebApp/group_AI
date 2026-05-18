/**
 * Webhook authentication middlewares.
 *
 * Two schemes supported:
 *
 *   1. verifyWixSecretHeader — legacy Wix form submissions.
 *      Checks `x-webhook-secret` header against WEBHOOK_SECRET.
 *
 *   2. verifyWordpressSignature — WordPress group form.
 *      Verifies HMAC-SHA256(rawBody, WP_WEBHOOK_SECRET) against `X-Signature`.
 *      Requires raw body to be captured by express.json({ verify }) in app.ts.
 */

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import config from '../config';
import logger from '../utils/logger';

/**
 * Legacy Wix-style auth (plain secret header).
 * Kept for the existing /api/v1/webhook endpoint.
 */
export function verifyWixSecretHeader(req: Request, res: Response, next: NextFunction) {
    const secret = config.webhook.wixSecret;

    if (!secret) {
        if (config.env === 'production') {
            logger.error('WEBHOOK_SECRET is not set in production — rejecting webhook');
            return res.status(500).json({
                error: { code: 'misconfigured', message: 'WEBHOOK_SECRET is not set' },
            });
        }
        // Dev mode — skip
        return next();
    }

    const provided = req.headers['x-webhook-secret'];
    if (!provided || provided !== secret) {
        logger.warn({ ip: req.ip }, 'Webhook rejected — invalid or missing x-webhook-secret');
        return res.status(401).json({
            error: { code: 'unauthorized', message: 'Invalid webhook secret' },
        });
    }
    next();
}

/**
 * HMAC-SHA256 signature verification for WordPress webhook.
 *
 * Expected header: `X-Signature: sha256=<hex-digest>`
 *
 * The hex digest is HMAC-SHA256 of the raw request body using WP_WEBHOOK_SECRET.
 * Uses `crypto.timingSafeEqual` to prevent timing attacks.
 */
export function verifyWordpressSignature(req: Request, res: Response, next: NextFunction) {
    const secret = config.webhook.wordpressSecret;

    if (!secret) {
        if (config.env === 'production') {
            logger.error('WP_WEBHOOK_SECRET is not set in production — rejecting webhook');
            return res.status(500).json({
                error: { code: 'misconfigured', message: 'WP_WEBHOOK_SECRET is not set' },
            });
        }
        // Dev mode — skip with a warning
        logger.warn('WP_WEBHOOK_SECRET not set — skipping signature verification (dev only)');
        return next();
    }

    const signatureHeader = req.headers['x-signature'] as string | undefined;
    if (!signatureHeader) {
        logger.warn({ ip: req.ip }, 'WordPress webhook rejected — missing X-Signature header');
        return res.status(401).json({
            error: { code: 'unauthorized', message: 'Missing X-Signature header' },
        });
    }

    // Expected format: "sha256=<hex>"
    const parts = signatureHeader.split('=');
    if (parts.length !== 2 || parts[0] !== 'sha256' || !parts[1]) {
        logger.warn({ ip: req.ip, signatureHeader }, 'WordPress webhook rejected — invalid signature format');
        return res.status(401).json({
            error: { code: 'unauthorized', message: 'Invalid signature format, expected: sha256=<hex>' },
        });
    }
    const providedHex = parts[1];

    // Raw body must have been captured by express.json({ verify }) in app.ts
    const rawBody: Buffer | undefined = (req as any).rawBody;
    if (!rawBody) {
        logger.error('WordPress webhook rejected — rawBody not captured by express.json');
        return res.status(500).json({
            error: { code: 'server_error', message: 'Raw body not captured — internal misconfiguration' },
        });
    }

    const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    // Both buffers must be equal length for timingSafeEqual
    let expected: Buffer;
    let provided: Buffer;
    try {
        expected = Buffer.from(expectedHex, 'hex');
        provided = Buffer.from(providedHex, 'hex');
    } catch {
        return res.status(401).json({
            error: { code: 'unauthorized', message: 'Invalid signature encoding' },
        });
    }

    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
        logger.warn({ ip: req.ip }, 'WordPress webhook rejected — signature mismatch');
        return res.status(401).json({
            error: { code: 'unauthorized', message: 'Invalid signature' },
        });
    }

    next();
}

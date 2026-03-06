import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import webhookController from '../controllers/webhook.controller';

const router = Router();

/**
 * Rate limit: allow a reasonable burst for form submissions from the SETT website.
 * 60 submissions per 15 minutes per IP.
 */
const webhookLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: { error: { code: 'rate_limited', message: 'Too many webhook requests' } },
});

/**
 * Shared secret authentication.
 * The SETT website must include the secret in `x-webhook-secret` header.
 * If WEBHOOK_SECRET is not set in .env, auth is skipped (dev mode only).
 */
function webhookAuth(req: Request, res: Response, next: NextFunction) {
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) {
        // No secret configured — allow in development, warn in production
        if (process.env.NODE_ENV === 'production') {
            return res.status(500).json({
                error: { code: 'misconfigured', message: 'WEBHOOK_SECRET is not set' },
            });
        }
        return next();
    }

    const provided = req.headers['x-webhook-secret'];
    if (!provided || provided !== secret) {
        return res.status(401).json({
            error: { code: 'unauthorized', message: 'Invalid or missing webhook secret' },
        });
    }

    next();
}

router.post('/', webhookLimiter, webhookAuth, webhookController.handleWebhook);

export default router;

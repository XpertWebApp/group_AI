import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import webhookController from '../controllers/webhook.controller';
import { verifyWixSecretHeader, verifyWordpressSignature } from '../middlewares/webhookAuth.middleware';

const router = Router();

/**
 * Rate limit: allow a reasonable burst for form submissions from the SETT website.
 * 60 submissions per 15 minutes per IP (shared across both endpoints).
 */
const webhookLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: { error: { code: 'rate_limited', message: 'Too many webhook requests' } },
});

/**
 * Legacy Wix webhook.
 * Auth: x-webhook-secret header.
 */
router.post('/', webhookLimiter, verifyWixSecretHeader, webhookController.handleWebhook);

/**
 * WordPress group form webhook (https://www.s-e-t-t.com/groups/).
 * Auth: HMAC-SHA256 via X-Signature header.
 */
router.post('/wordpress', webhookLimiter, verifyWordpressSignature, webhookController.handleWordpressWebhook);

export default router;

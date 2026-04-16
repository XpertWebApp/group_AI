"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const webhook_controller_1 = __importDefault(require("../controllers/webhook.controller"));
const router = (0, express_1.Router)();
/**
 * Rate limit: allow a reasonable burst for form submissions from the SETT website.
 * 60 submissions per 15 minutes per IP.
 */
const webhookLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: { error: { code: 'rate_limited', message: 'Too many webhook requests' } },
});
/**
 * Shared secret authentication.
 * The SETT website must include the secret in `x-webhook-secret` header.
 * If WEBHOOK_SECRET is not set in .env, auth is skipped (dev mode only).
 */
function webhookAuth(req, res, next) {
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
router.post('/', webhookLimiter, webhookAuth, webhook_controller_1.default.handleWebhook);
exports.default = router;

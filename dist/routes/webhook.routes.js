"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const webhook_controller_1 = __importDefault(require("../controllers/webhook.controller"));
const webhookAuth_middleware_1 = require("../middlewares/webhookAuth.middleware");
const router = (0, express_1.Router)();
/**
 * Rate limit: allow a reasonable burst for form submissions from the SETT website.
 * 60 submissions per 15 minutes per IP (shared across both endpoints).
 */
const webhookLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: { error: { code: 'rate_limited', message: 'Too many webhook requests' } },
});
/**
 * Legacy Wix webhook.
 * Auth: x-webhook-secret header.
 */
router.post('/', webhookLimiter, webhookAuth_middleware_1.verifyWixSecretHeader, webhook_controller_1.default.handleWebhook);
/**
 * WordPress group form webhook (https://www.s-e-t-t.com/groups/).
 * Auth: HMAC-SHA256 via X-Signature header.
 */
router.post('/wordpress', webhookLimiter, webhookAuth_middleware_1.verifyWordpressSignature, webhook_controller_1.default.handleWordpressWebhook);
exports.default = router;

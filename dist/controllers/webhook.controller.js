"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookController = void 0;
const webhook_service_1 = __importDefault(require("../services/webhook.service"));
const wordpressWebhook_service_1 = __importDefault(require("../services/wordpressWebhook.service"));
const response_1 = require("../utils/response");
class WebhookController {
    /**
     * Legacy Wix webhook.
     * Auth: x-webhook-secret header.
     * Path: POST /api/v1/webhook
     */
    async handleWebhook(req, res, next) {
        try {
            const payload = req.body;
            const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
            const result = await webhook_service_1.default.processWebhook(payload, clientIp);
            return (0, response_1.sendResponse)(res, 200, result, 'Webhook processed successfully');
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * WordPress group form webhook.
     * Auth: HMAC-SHA256 via X-Signature header (verified by middleware).
     * Path: POST /api/v1/webhook/wordpress
     */
    async handleWordpressWebhook(req, res, next) {
        try {
            const payload = req.body;
            const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
            const result = await wordpressWebhook_service_1.default.processWordpressWebhook(payload, clientIp);
            return (0, response_1.sendResponse)(res, 200, result, 'WordPress webhook processed successfully');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.WebhookController = WebhookController;
exports.default = new WebhookController();

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookController = void 0;
const webhook_service_1 = __importDefault(require("../services/webhook.service"));
const response_1 = require("../utils/response");
class WebhookController {
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
}
exports.WebhookController = WebhookController;
exports.default = new WebhookController();

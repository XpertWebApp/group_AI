import { Request, Response, NextFunction } from 'express';
import webhookService from '../services/webhook.service';
import wordpressWebhookService from '../services/wordpressWebhook.service';
import { sendResponse } from '../utils/response';

export class WebhookController {
    /**
     * Legacy Wix webhook.
     * Auth: x-webhook-secret header.
     * Path: POST /api/v1/webhook
     */
    async handleWebhook(req: Request, res: Response, next: NextFunction) {
        try {
            const payload = req.body;
            const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

            const result = await webhookService.processWebhook(payload, clientIp);

            return sendResponse(res, 200, result, 'Webhook processed successfully');
        } catch (error) {
            next(error);
        }
    }

    /**
     * WordPress group form webhook.
     * Auth: HMAC-SHA256 via X-Signature header (verified by middleware).
     * Path: POST /api/v1/webhook/wordpress
     */
    async handleWordpressWebhook(req: Request, res: Response, next: NextFunction) {
        try {
            const payload = req.body;
            const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

            const result = await wordpressWebhookService.processWordpressWebhook(payload, clientIp);

            return sendResponse(res, 200, result, 'WordPress webhook processed successfully');
        } catch (error) {
            next(error);
        }
    }
}

export default new WebhookController();

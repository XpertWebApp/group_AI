import { Request, Response, NextFunction } from 'express';
import webhookService from '../services/webhook.service';
import { sendResponse } from '../utils/response';

export class WebhookController {
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
}

export default new WebhookController();

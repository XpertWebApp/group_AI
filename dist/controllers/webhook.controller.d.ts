import { Request, Response, NextFunction } from 'express';
export declare class WebhookController {
    handleWebhook(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
}
declare const _default: WebhookController;
export default _default;

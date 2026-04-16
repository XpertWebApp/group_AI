import { Request, Response, NextFunction } from 'express';
export declare class GoogleAuthController {
    /**
     * GET /api/v1/auth/google/connect
     *
     * Returns the Google OAuth consent URL.
     * The frontend opens this URL so the user can grant Gmail send permission.
     */
    connect(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * GET /api/v1/auth/google/callback
     *
     * Google redirects here after the user grants permission.
     * Exchanges the authorization code for tokens and stores them.
     * Then redirects the browser back to the frontend.
     */
    callback(req: Request, res: Response, next: NextFunction): Promise<void>;
    /**
     * GET /api/v1/auth/google/status
     *
     * Check if the current user has connected their Google account.
     */
    status(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * POST /api/v1/auth/google/disconnect
     *
     * Revoke Google access and clear stored tokens.
     */
    disconnect(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
}
declare const _default: GoogleAuthController;
export default _default;

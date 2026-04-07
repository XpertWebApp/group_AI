import { Request, Response, NextFunction } from 'express';
import gmailService from '../services/gmail.service';
import { sendResponse } from '../utils/response';
import { logAuditEvent } from '../utils/audit';
import logger from '../utils/logger';

export class GoogleAuthController {
    /**
     * GET /api/v1/auth/google/connect
     *
     * Returns the Google OAuth consent URL.
     * The frontend opens this URL so the user can grant Gmail send permission.
     */
    async connect(req: Request, res: Response, next: NextFunction) {
        try {
            const userId = (req as any).user.id;
            const url = gmailService.getAuthUrl(userId);
            return sendResponse(res, 200, { url }, 'Google OAuth URL generated');
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v1/auth/google/callback
     *
     * Google redirects here after the user grants permission.
     * Exchanges the authorization code for tokens and stores them.
     * Then redirects the browser back to the frontend.
     */
    async callback(req: Request, res: Response, next: NextFunction) {
        try {
            const { code, state, error: oauthError } = req.query;
            const frontendUrl = process.env.CORS_ORIGIN || 'http://localhost:3000';

            if (oauthError) {
                logger.warn({ oauthError }, 'User denied Google OAuth consent');
                return res.redirect(`${frontendUrl}/settings?google=denied`);
            }

            if (!code || !state) {
                throw { status: 400, message: 'Missing code or state parameter', code: 'INVALID_CALLBACK' };
            }

            const userId = state as string;
            await gmailService.handleCallback(code as string, userId);

            await logAuditEvent({
                userId,
                action: 'google_oauth_connect',
                entity: 'user',
                entityId: userId,
            });

            return res.redirect(`${frontendUrl}/settings?google=connected`);
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v1/auth/google/status
     *
     * Check if the current user has connected their Google account.
     */
    async status(req: Request, res: Response, next: NextFunction) {
        try {
            const userId = (req as any).user.id;
            const status = await gmailService.getConnectionStatus(userId);
            return sendResponse(res, 200, status, 'Google connection status');
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/v1/auth/google/disconnect
     *
     * Revoke Google access and clear stored tokens.
     */
    async disconnect(req: Request, res: Response, next: NextFunction) {
        try {
            const userId = (req as any).user.id;
            await gmailService.disconnect(userId);

            await logAuditEvent({
                userId,
                action: 'google_oauth_disconnect',
                entity: 'user',
                entityId: userId,
            });

            return sendResponse(res, 200, null, 'Google account disconnected');
        } catch (error) {
            next(error);
        }
    }
}

export default new GoogleAuthController();

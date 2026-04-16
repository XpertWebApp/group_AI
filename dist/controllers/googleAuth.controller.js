"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleAuthController = void 0;
const gmail_service_1 = __importDefault(require("../services/gmail.service"));
const response_1 = require("../utils/response");
const audit_1 = require("../utils/audit");
const logger_1 = __importDefault(require("../utils/logger"));
class GoogleAuthController {
    /**
     * GET /api/v1/auth/google/connect
     *
     * Returns the Google OAuth consent URL.
     * The frontend opens this URL so the user can grant Gmail send permission.
     */
    async connect(req, res, next) {
        try {
            const userId = req.user.id;
            // Optional `returnTo` query param — frontend can pass the path it wants
            // the user to land on after the OAuth flow completes.
            // e.g. GET /api/v1/auth/google/connect?returnTo=/connect-google
            const returnToRaw = req.query.returnTo?.trim();
            const returnTo = (returnToRaw && returnToRaw.startsWith('/') && !returnToRaw.includes('|'))
                ? returnToRaw
                : null;
            const state = returnTo ? `${userId}|${returnTo}` : userId;
            const url = gmail_service_1.default.getAuthUrl(state);
            return (0, response_1.sendResponse)(res, 200, { url }, 'Google OAuth URL generated');
        }
        catch (error) {
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
    async callback(req, res, next) {
        try {
            const { code, state, error: oauthError } = req.query;
            const frontendUrl = process.env.CORS_ORIGIN || 'http://localhost:3000';
            // The state param is encoded as either:
            //   - userId only (legacy)               → e.g. "abc-123"
            //   - userId|returnTo (current)          → e.g. "abc-123|/connect-google"
            // returnTo lets the frontend send the user back to whichever page they
            // started the connect flow from (instead of always /settings).
            const stateStr = state ?? '';
            const [userId, returnToRaw] = stateStr.split('|');
            const returnTo = (returnToRaw && returnToRaw.startsWith('/'))
                ? returnToRaw
                : '/settings'; // safe default
            if (oauthError) {
                logger_1.default.warn({ oauthError }, 'User denied Google OAuth consent');
                return res.redirect(`${frontendUrl}${returnTo}?google=denied`);
            }
            if (!code || !userId) {
                throw { status: 400, message: 'Missing code or state parameter', code: 'INVALID_CALLBACK' };
            }
            await gmail_service_1.default.handleCallback(code, userId);
            await (0, audit_1.logAuditEvent)({
                userId,
                action: 'google_oauth_connect',
                entity: 'user',
                entityId: userId,
            });
            return res.redirect(`${frontendUrl}${returnTo}?google=connected`);
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * GET /api/v1/auth/google/status
     *
     * Check if the current user has connected their Google account.
     */
    async status(req, res, next) {
        try {
            const userId = req.user.id;
            const status = await gmail_service_1.default.getConnectionStatus(userId);
            return (0, response_1.sendResponse)(res, 200, status, 'Google connection status');
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * POST /api/v1/auth/google/disconnect
     *
     * Revoke Google access and clear stored tokens.
     */
    async disconnect(req, res, next) {
        try {
            const userId = req.user.id;
            await gmail_service_1.default.disconnect(userId);
            await (0, audit_1.logAuditEvent)({
                userId,
                action: 'google_oauth_disconnect',
                entity: 'user',
                entityId: userId,
            });
            return (0, response_1.sendResponse)(res, 200, null, 'Google account disconnected');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.GoogleAuthController = GoogleAuthController;
exports.default = new GoogleAuthController();

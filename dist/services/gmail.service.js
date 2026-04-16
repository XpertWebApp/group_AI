"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GmailService = void 0;
const googleapis_1 = require("googleapis");
const config_1 = __importDefault(require("../config"));
const user_repository_1 = __importDefault(require("../repositories/user.repository"));
const tokenEncryption_1 = require("../utils/tokenEncryption");
const logger_1 = __importDefault(require("../utils/logger"));
const emailErrors_1 = require("./email/emailErrors");
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const USERINFO_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
class GmailService {
    createOAuth2Client() {
        return new googleapis_1.google.auth.OAuth2(config_1.default.google.clientId, config_1.default.google.clientSecret, config_1.default.google.redirectUri);
    }
    /**
     * Generate the Google consent URL for a user to connect their Gmail account.
     * The state parameter carries the userId so the callback knows who to store tokens for.
     *
     * Scopes:
     *  - gmail.send       — required to send emails on behalf of the user
     *  - userinfo.email   — required to fetch the connected Google account email address
     */
    getAuthUrl(state) {
        const client = this.createOAuth2Client();
        return client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: [GMAIL_SEND_SCOPE, USERINFO_EMAIL_SCOPE],
            state,
        });
    }
    /**
     * Exchange authorization code for tokens, encrypt and store them for the user.
     * Also fetches the connected Gmail address via gmail.users.getProfile and stores it,
     * so the frontend can display which Google account is connected.
     */
    async handleCallback(code, userId) {
        const client = this.createOAuth2Client();
        const { tokens } = await client.getToken(code);
        if (!tokens.refresh_token) {
            throw {
                status: 400,
                message: 'No refresh token received from Google. Please revoke access at https://myaccount.google.com/permissions and try again.',
                code: 'GOOGLE_NO_REFRESH_TOKEN',
            };
        }
        // Fetch the connected Google account email (best-effort — don't fail the connect flow if this errors)
        let googleEmail = null;
        try {
            client.setCredentials(tokens);
            const oauth2 = googleapis_1.google.oauth2({ version: 'v2', auth: client });
            const userinfo = await oauth2.userinfo.get();
            googleEmail = userinfo.data.email ?? null;
        }
        catch (err) {
            logger_1.default.warn({ err: err?.message, userId }, 'Failed to fetch connected Google email — continuing without it');
        }
        await user_repository_1.default.updateGoogleTokens(userId, {
            googleAccessToken: tokens.access_token ? (0, tokenEncryption_1.encryptToken)(tokens.access_token) : null,
            googleRefreshToken: (0, tokenEncryption_1.encryptToken)(tokens.refresh_token),
            googleTokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
            googleEmail,
        });
        logger_1.default.info({ userId, googleEmail }, 'Google OAuth tokens stored successfully');
    }
    /**
     * Get an authenticated OAuth2 client for a specific user.
     * Auto-refreshes expired tokens and persists the new access token.
     * Returns a discriminated union with a specific EmailFailure code on failure
     * so the caller can distinguish NOT_CONNECTED from TOKEN_REVOKED, etc.
     */
    async getAuthenticatedClient(userId) {
        let stored;
        try {
            stored = await user_repository_1.default.getGoogleTokens(userId);
        }
        catch (err) {
            logger_1.default.error({ userId, err: err?.message }, 'Failed to read Google tokens from DB');
            return { ok: false, failure: (0, emailErrors_1.failure)('GMAIL_UNKNOWN', { detail: `DB read failed: ${err?.message}` }) };
        }
        if (!stored?.googleRefreshToken) {
            return { ok: false, failure: (0, emailErrors_1.failure)('NOT_CONNECTED') };
        }
        const client = this.createOAuth2Client();
        let refreshToken;
        let accessToken;
        try {
            refreshToken = (0, tokenEncryption_1.decryptToken)(stored.googleRefreshToken);
            accessToken = stored.googleAccessToken ? (0, tokenEncryption_1.decryptToken)(stored.googleAccessToken) : undefined;
        }
        catch (err) {
            logger_1.default.error({ userId, err: err?.message }, 'Token decryption failed — encryption key rotation or corrupted ciphertext');
            return { ok: false, failure: (0, emailErrors_1.failure)('TOKEN_DECRYPT_FAILED', { detail: err?.message }) };
        }
        const expiryDate = stored.googleTokenExpiry ? stored.googleTokenExpiry.getTime() : undefined;
        client.setCredentials({
            refresh_token: refreshToken,
            access_token: accessToken,
            expiry_date: expiryDate,
        });
        // Proactively refresh if expired or expiring within 60s
        if (!expiryDate || Date.now() >= expiryDate - 60000) {
            try {
                const { credentials } = await client.refreshAccessToken();
                await user_repository_1.default.updateGoogleTokens(userId, {
                    googleAccessToken: credentials.access_token ? (0, tokenEncryption_1.encryptToken)(credentials.access_token) : stored.googleAccessToken,
                    googleRefreshToken: stored.googleRefreshToken,
                    googleTokenExpiry: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
                });
                client.setCredentials(credentials);
                logger_1.default.info({ userId }, 'Google access token refreshed');
            }
            catch (err) {
                if (err?.response?.data?.error === 'invalid_grant') {
                    await user_repository_1.default.clearGoogleTokens(userId);
                    logger_1.default.warn({ userId }, 'Google access revoked — tokens cleared');
                    return { ok: false, failure: (0, emailErrors_1.failure)('TOKEN_REVOKED', { detail: 'invalid_grant on refresh' }) };
                }
                logger_1.default.error({ userId, err: err?.message }, 'Google token refresh failed (non-invalid_grant)');
                return { ok: false, failure: (0, emailErrors_1.failure)('GMAIL_UPSTREAM', { detail: `refresh failed: ${err?.message}` }) };
            }
        }
        // Backfill googleEmail for users who connected before the googleEmail field existed.
        // This avoids the "From: <null>" MIME header issue and populates the status endpoint.
        let googleEmail = stored.googleEmail;
        if (!googleEmail) {
            try {
                const oauth2 = googleapis_1.google.oauth2({ version: 'v2', auth: client });
                const userinfo = await oauth2.userinfo.get();
                googleEmail = userinfo.data.email ?? null;
                if (googleEmail) {
                    await user_repository_1.default.updateGoogleTokens(userId, {
                        googleAccessToken: stored.googleAccessToken,
                        googleRefreshToken: stored.googleRefreshToken,
                        googleTokenExpiry: stored.googleTokenExpiry,
                        googleEmail,
                    });
                    logger_1.default.info({ userId, googleEmail }, 'Backfilled googleEmail for existing connection');
                }
            }
            catch (err) {
                // If userinfo returns 401, the token is dead — clear and report TOKEN_REVOKED
                const status = err?.code ?? err?.response?.status;
                if (status === 401) {
                    await user_repository_1.default.clearGoogleTokens(userId);
                    logger_1.default.warn({ userId }, 'userinfo.get returned 401 during backfill — tokens cleared');
                    return { ok: false, failure: (0, emailErrors_1.failure)('TOKEN_REVOKED', { detail: 'userinfo backfill 401' }) };
                }
                logger_1.default.warn({ err: err?.message, userId }, 'Failed to backfill googleEmail — proceeding without it');
            }
        }
        return { ok: true, client, email: googleEmail };
    }
    /**
     * Check if a user has connected their Google account.
     */
    async isConnected(userId) {
        const stored = await user_repository_1.default.getGoogleTokens(userId);
        return !!(stored?.googleRefreshToken);
    }
    /**
     * Get the connection status + connected Gmail address for a user.
     * Used by GET /api/v1/auth/google/status to populate the frontend display.
     */
    async getConnectionStatus(userId) {
        const stored = await user_repository_1.default.getGoogleTokens(userId);
        const connected = !!(stored?.googleRefreshToken);
        return {
            connected,
            email: connected ? (stored?.googleEmail ?? null) : null,
        };
    }
    /**
     * Disconnect — revoke token at Google and clear stored tokens.
     */
    async disconnect(userId) {
        const stored = await user_repository_1.default.getGoogleTokens(userId);
        if (stored?.googleRefreshToken) {
            try {
                const client = this.createOAuth2Client();
                await client.revokeToken((0, tokenEncryption_1.decryptToken)(stored.googleRefreshToken));
            }
            catch {
                // Best-effort revocation
            }
        }
        await user_repository_1.default.clearGoogleTokens(userId);
        logger_1.default.info({ userId }, 'Google account disconnected');
    }
    /**
     * Send an email via Gmail API on behalf of the user.
     *
     * Returns a discriminated union (`EmailSendResult`):
     *  - `{ ok: true, method: 'gmail' }` on success
     *  - `{ ok: false, method: 'gmail', failure }` on failure with a specific code
     *
     * Never throws under normal failure modes — only throws for true programmer errors.
     * Callers (sendEmailWithFallback) should inspect `failure.code` to decide whether
     * to fall back to SMTP or surface the error directly.
     */
    async sendEmail(userId, opts) {
        const auth = await this.getAuthenticatedClient(userId);
        if (!auth.ok) {
            logger_1.default.warn({ userId, code: auth.failure.code }, 'Gmail sendEmail: auth client unavailable');
            return { ok: false, method: 'gmail', failure: auth.failure };
        }
        const { client, email: senderEmail } = auth;
        const gmail = googleapis_1.google.gmail({ version: 'v1', auth: client });
        const raw = this.buildRawEmail({
            // Pass the connected Gmail address if known. If null, omit From entirely
            // and Gmail will populate it with the authorized account.
            from: senderEmail ?? undefined,
            to: opts.to,
            subject: opts.subject,
            html: opts.html,
            attachments: opts.attachments,
        });
        try {
            await gmail.users.messages.send({
                userId: 'me',
                requestBody: { raw },
            });
            logger_1.default.info({ userId, to: opts.to, subject: opts.subject, senderEmail }, 'Email sent via Gmail API');
            return { ok: true, method: 'gmail' };
        }
        catch (err) {
            // Capture the actual error details for diagnosis
            const status = err?.code ?? err?.response?.status;
            const apiError = err?.response?.data?.error?.message ??
                err?.response?.data?.error ??
                err?.errors?.[0]?.message ??
                err?.errors?.[0] ??
                err?.message;
            const detailStr = typeof apiError === 'string' ? apiError : JSON.stringify(apiError);
            logger_1.default.error({ userId, to: opts.to, status, apiError, senderEmail, message: err?.message }, 'Gmail API send error');
            // 401: tokens are dead — clear them and return TOKEN_REVOKED-style failure.
            if (status === 401) {
                await user_repository_1.default.clearGoogleTokens(userId);
                logger_1.default.warn({ userId }, 'Gmail send failed (401) — tokens cleared');
                return {
                    ok: false,
                    method: 'gmail',
                    failure: (0, emailErrors_1.failure)('GMAIL_UNAUTHORIZED', { detail: detailStr }),
                };
            }
            // 403: scope missing, quota, sender mismatch, or workspace policy
            if (status === 403) {
                return {
                    ok: false,
                    method: 'gmail',
                    failure: (0, emailErrors_1.failure)('GMAIL_FORBIDDEN', { detail: detailStr }),
                };
            }
            // 400: malformed MIME — likely our bug building the message
            if (status === 400) {
                return {
                    ok: false,
                    method: 'gmail',
                    failure: (0, emailErrors_1.failure)('GMAIL_BAD_REQUEST', { detail: detailStr }),
                };
            }
            // 5xx: Google upstream — transient
            if (typeof status === 'number' && status >= 500 && status < 600) {
                return {
                    ok: false,
                    method: 'gmail',
                    failure: (0, emailErrors_1.failure)('GMAIL_UPSTREAM', { detail: detailStr }),
                };
            }
            // Network errors
            const errCode = err?.code;
            if (errCode === 'ENOTFOUND' || errCode === 'ECONNRESET' || errCode === 'ETIMEDOUT' || errCode === 'EAI_AGAIN') {
                return {
                    ok: false,
                    method: 'gmail',
                    failure: (0, emailErrors_1.failure)('GMAIL_NETWORK', { detail: errCode }),
                };
            }
            // Anything else
            return {
                ok: false,
                method: 'gmail',
                failure: (0, emailErrors_1.failure)('GMAIL_UNKNOWN', { detail: detailStr }),
            };
        }
    }
    /**
     * RFC 2047 MIME encoded-word for non-ASCII header values (e.g. subject lines
     * with em-dash, accented characters, emoji, etc.). Without this, Gmail sends
     * the raw UTF-8 bytes which most email clients render as Latin-1 mojibake.
     *
     * Format: =?UTF-8?B?<base64>?=
     * Pure-ASCII strings are returned unchanged so we don't waste bytes.
     */
    encodeHeader(value) {
        // eslint-disable-next-line no-control-regex
        if (/^[\x00-\x7F]*$/.test(value))
            return value;
        const b64 = Buffer.from(value, 'utf8').toString('base64');
        return `=?UTF-8?B?${b64}?=`;
    }
    /**
     * Build RFC 2822 MIME message and base64url encode it.
     * If `from` is not provided, the From header is omitted and Gmail
     * will use the authorized account automatically.
     */
    buildRawEmail(opts) {
        const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const hasAttachments = opts.attachments && opts.attachments.length > 0;
        let message = '';
        if (opts.from) {
            message += `From: ${this.encodeHeader(opts.from)}\r\n`;
        }
        message += `To: ${this.encodeHeader(opts.to)}\r\n`;
        message += `Subject: ${this.encodeHeader(opts.subject)}\r\n`;
        message += `MIME-Version: 1.0\r\n`;
        if (hasAttachments) {
            message += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
            message += `--${boundary}\r\n`;
            message += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
            message += `${opts.html}\r\n`;
            for (const att of opts.attachments) {
                message += `--${boundary}\r\n`;
                message += `Content-Type: ${att.contentType}; name="${att.filename}"\r\n`;
                message += `Content-Disposition: attachment; filename="${att.filename}"\r\n`;
                message += `Content-Transfer-Encoding: base64\r\n\r\n`;
                message += `${att.content.toString('base64')}\r\n`;
            }
            message += `--${boundary}--`;
        }
        else {
            message += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
            message += opts.html;
        }
        return Buffer.from(message)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }
}
exports.GmailService = GmailService;
exports.default = new GmailService();

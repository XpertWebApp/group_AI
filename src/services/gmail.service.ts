import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import config from '../config';
import userRepository from '../repositories/user.repository';
import { encryptToken, decryptToken } from '../utils/tokenEncryption';
import logger from '../utils/logger';
import { EmailFailure, EmailSendResult, failure } from './email/emailErrors';

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const USERINFO_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

/**
 * Result of getting an authenticated OAuth2 client for a user.
 * On success, contains the client + connected Google email (may be null if backfill failed).
 * On failure, carries an EmailFailure with a specific code (NOT_CONNECTED, TOKEN_REVOKED, etc.).
 */
type AuthClientResult =
    | { ok: true; client: OAuth2Client; email: string | null }
    | { ok: false; failure: EmailFailure };

export class GmailService {
    private createOAuth2Client() {
        return new google.auth.OAuth2(
            config.google.clientId,
            config.google.clientSecret,
            config.google.redirectUri,
        );
    }

    /**
     * Generate the Google consent URL for a user to connect their Gmail account.
     * The state parameter carries the userId so the callback knows who to store tokens for.
     *
     * Scopes:
     *  - gmail.send       — required to send emails on behalf of the user
     *  - userinfo.email   — required to fetch the connected Google account email address
     */
    getAuthUrl(state: string): string {
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
    async handleCallback(code: string, userId: string): Promise<void> {
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
        let googleEmail: string | null = null;
        try {
            client.setCredentials(tokens);
            const oauth2 = google.oauth2({ version: 'v2', auth: client });
            const userinfo = await oauth2.userinfo.get();
            googleEmail = userinfo.data.email ?? null;
        } catch (err: any) {
            logger.warn({ err: err?.message, userId }, 'Failed to fetch connected Google email — continuing without it');
        }

        await userRepository.updateGoogleTokens(userId, {
            googleAccessToken: tokens.access_token ? encryptToken(tokens.access_token) : null,
            googleRefreshToken: encryptToken(tokens.refresh_token),
            googleTokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
            googleEmail,
        });

        logger.info({ userId, googleEmail }, 'Google OAuth tokens stored successfully');
    }

    /**
     * Get an authenticated OAuth2 client for a specific user.
     * Auto-refreshes expired tokens and persists the new access token.
     * Returns a discriminated union with a specific EmailFailure code on failure
     * so the caller can distinguish NOT_CONNECTED from TOKEN_REVOKED, etc.
     */
    private async getAuthenticatedClient(userId: string): Promise<AuthClientResult> {
        let stored;
        try {
            stored = await userRepository.getGoogleTokens(userId);
        } catch (err: any) {
            logger.error({ userId, err: err?.message }, 'Failed to read Google tokens from DB');
            return { ok: false, failure: failure('GMAIL_UNKNOWN', { detail: `DB read failed: ${err?.message}` }) };
        }

        if (!stored?.googleRefreshToken) {
            return { ok: false, failure: failure('NOT_CONNECTED') };
        }

        const client = this.createOAuth2Client();
        let refreshToken: string;
        let accessToken: string | undefined;
        try {
            refreshToken = decryptToken(stored.googleRefreshToken);
            accessToken = stored.googleAccessToken ? decryptToken(stored.googleAccessToken) : undefined;
        } catch (err: any) {
            logger.error({ userId, err: err?.message }, 'Token decryption failed — encryption key rotation or corrupted ciphertext');
            return { ok: false, failure: failure('TOKEN_DECRYPT_FAILED', { detail: err?.message }) };
        }

        const expiryDate = stored.googleTokenExpiry ? stored.googleTokenExpiry.getTime() : undefined;

        client.setCredentials({
            refresh_token: refreshToken,
            access_token: accessToken,
            expiry_date: expiryDate,
        });

        // Proactively refresh if expired or expiring within 60s
        if (!expiryDate || Date.now() >= expiryDate - 60_000) {
            try {
                const { credentials } = await client.refreshAccessToken();
                await userRepository.updateGoogleTokens(userId, {
                    googleAccessToken: credentials.access_token ? encryptToken(credentials.access_token) : stored.googleAccessToken,
                    googleRefreshToken: stored.googleRefreshToken,
                    googleTokenExpiry: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
                });
                client.setCredentials(credentials);
                logger.info({ userId }, 'Google access token refreshed');
            } catch (err: any) {
                if (err?.response?.data?.error === 'invalid_grant') {
                    await userRepository.clearGoogleTokens(userId);
                    logger.warn({ userId }, 'Google access revoked — tokens cleared');
                    return { ok: false, failure: failure('TOKEN_REVOKED', { detail: 'invalid_grant on refresh' }) };
                }
                logger.error({ userId, err: err?.message }, 'Google token refresh failed (non-invalid_grant)');
                return { ok: false, failure: failure('GMAIL_UPSTREAM', { detail: `refresh failed: ${err?.message}` }) };
            }
        }

        // Backfill googleEmail for users who connected before the googleEmail field existed.
        // This avoids the "From: <null>" MIME header issue and populates the status endpoint.
        let googleEmail = stored.googleEmail;
        if (!googleEmail) {
            try {
                const oauth2 = google.oauth2({ version: 'v2', auth: client });
                const userinfo = await oauth2.userinfo.get();
                googleEmail = userinfo.data.email ?? null;
                if (googleEmail) {
                    await userRepository.updateGoogleTokens(userId, {
                        googleAccessToken: stored.googleAccessToken,
                        googleRefreshToken: stored.googleRefreshToken,
                        googleTokenExpiry: stored.googleTokenExpiry,
                        googleEmail,
                    });
                    logger.info({ userId, googleEmail }, 'Backfilled googleEmail for existing connection');
                }
            } catch (err: any) {
                // If userinfo returns 401, the token is dead — clear and report TOKEN_REVOKED
                const status = err?.code ?? err?.response?.status;
                if (status === 401) {
                    await userRepository.clearGoogleTokens(userId);
                    logger.warn({ userId }, 'userinfo.get returned 401 during backfill — tokens cleared');
                    return { ok: false, failure: failure('TOKEN_REVOKED', { detail: 'userinfo backfill 401' }) };
                }
                logger.warn({ err: err?.message, userId }, 'Failed to backfill googleEmail — proceeding without it');
            }
        }

        return { ok: true, client, email: googleEmail };
    }

    /**
     * Check if a user has connected their Google account.
     */
    async isConnected(userId: string): Promise<boolean> {
        const stored = await userRepository.getGoogleTokens(userId);
        return !!(stored?.googleRefreshToken);
    }

    /**
     * Get the connection status + connected Gmail address for a user.
     * Used by GET /api/v1/auth/google/status to populate the frontend display.
     */
    async getConnectionStatus(userId: string): Promise<{ connected: boolean; email: string | null }> {
        const stored = await userRepository.getGoogleTokens(userId);
        const connected = !!(stored?.googleRefreshToken);
        return {
            connected,
            email: connected ? (stored?.googleEmail ?? null) : null,
        };
    }

    /**
     * Disconnect — revoke token at Google and clear stored tokens.
     */
    async disconnect(userId: string): Promise<void> {
        const stored = await userRepository.getGoogleTokens(userId);
        if (stored?.googleRefreshToken) {
            try {
                const client = this.createOAuth2Client();
                await client.revokeToken(decryptToken(stored.googleRefreshToken));
            } catch {
                // Best-effort revocation
            }
        }
        await userRepository.clearGoogleTokens(userId);
        logger.info({ userId }, 'Google account disconnected');
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
    async sendEmail(
        userId: string,
        opts: {
            to: string;
            subject: string;
            html: string;
            attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
        },
    ): Promise<EmailSendResult> {
        const auth = await this.getAuthenticatedClient(userId);
        if (!auth.ok) {
            logger.warn({ userId, code: auth.failure.code }, 'Gmail sendEmail: auth client unavailable');
            return { ok: false, method: 'gmail', failure: auth.failure };
        }

        const { client, email: senderEmail } = auth;
        const gmail = google.gmail({ version: 'v1', auth: client });

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
            logger.info({ userId, to: opts.to, subject: opts.subject, senderEmail }, 'Email sent via Gmail API');
            return { ok: true, method: 'gmail' };
        } catch (err: any) {
            // Capture the actual error details for diagnosis
            const status = err?.code ?? err?.response?.status;
            const apiError =
                err?.response?.data?.error?.message ??
                err?.response?.data?.error ??
                err?.errors?.[0]?.message ??
                err?.errors?.[0] ??
                err?.message;
            const detailStr = typeof apiError === 'string' ? apiError : JSON.stringify(apiError);

            logger.error(
                { userId, to: opts.to, status, apiError, senderEmail, message: err?.message },
                'Gmail API send error',
            );

            // 401: tokens are dead — clear them and return TOKEN_REVOKED-style failure.
            if (status === 401) {
                await userRepository.clearGoogleTokens(userId);
                logger.warn({ userId }, 'Gmail send failed (401) — tokens cleared');
                return {
                    ok: false,
                    method: 'gmail',
                    failure: failure('GMAIL_UNAUTHORIZED', { detail: detailStr }),
                };
            }

            // 403: scope missing, quota, sender mismatch, or workspace policy
            if (status === 403) {
                return {
                    ok: false,
                    method: 'gmail',
                    failure: failure('GMAIL_FORBIDDEN', { detail: detailStr }),
                };
            }

            // 400: malformed MIME — likely our bug building the message
            if (status === 400) {
                return {
                    ok: false,
                    method: 'gmail',
                    failure: failure('GMAIL_BAD_REQUEST', { detail: detailStr }),
                };
            }

            // 5xx: Google upstream — transient
            if (typeof status === 'number' && status >= 500 && status < 600) {
                return {
                    ok: false,
                    method: 'gmail',
                    failure: failure('GMAIL_UPSTREAM', { detail: detailStr }),
                };
            }

            // Network errors
            const errCode = err?.code;
            if (errCode === 'ENOTFOUND' || errCode === 'ECONNRESET' || errCode === 'ETIMEDOUT' || errCode === 'EAI_AGAIN') {
                return {
                    ok: false,
                    method: 'gmail',
                    failure: failure('GMAIL_NETWORK', { detail: errCode }),
                };
            }

            // Anything else
            return {
                ok: false,
                method: 'gmail',
                failure: failure('GMAIL_UNKNOWN', { detail: detailStr }),
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
    private encodeHeader(value: string): string {
        // eslint-disable-next-line no-control-regex
        if (/^[\x00-\x7F]*$/.test(value)) return value;
        const b64 = Buffer.from(value, 'utf8').toString('base64');
        return `=?UTF-8?B?${b64}?=`;
    }

    /**
     * Build RFC 2822 MIME message and base64url encode it.
     * If `from` is not provided, the From header is omitted and Gmail
     * will use the authorized account automatically.
     */
    private buildRawEmail(opts: {
        from?: string;
        to: string;
        subject: string;
        html: string;
        attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
    }): string {
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

            for (const att of opts.attachments!) {
                message += `--${boundary}\r\n`;
                message += `Content-Type: ${att.contentType}; name="${att.filename}"\r\n`;
                message += `Content-Disposition: attachment; filename="${att.filename}"\r\n`;
                message += `Content-Transfer-Encoding: base64\r\n\r\n`;
                message += `${att.content.toString('base64')}\r\n`;
            }
            message += `--${boundary}--`;
        } else {
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

export default new GmailService();

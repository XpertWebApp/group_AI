import { google } from 'googleapis';
import config from '../config';
import userRepository from '../repositories/user.repository';
import { encryptToken, decryptToken } from '../utils/tokenEncryption';
import logger from '../utils/logger';

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const USERINFO_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

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
     * Returns null if user has not connected Google or access was revoked.
     */
    private async getAuthenticatedClient(userId: string) {
        const stored = await userRepository.getGoogleTokens(userId);
        if (!stored?.googleRefreshToken) return null;

        const client = this.createOAuth2Client();
        const refreshToken = decryptToken(stored.googleRefreshToken);
        const accessToken = stored.googleAccessToken ? decryptToken(stored.googleAccessToken) : undefined;
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
                    return null;
                }
                throw err;
            }
        }

        return { client, email: stored.googleEmail };
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
     * Returns true if sent, false if user not connected (caller should fall back to SMTP).
     */
    async sendEmail(userId: string, opts: {
        to: string;
        subject: string;
        html: string;
        attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
    }): Promise<boolean> {
        const result = await this.getAuthenticatedClient(userId);
        if (!result) return false;

        const { client, email: senderEmail } = result;
        const gmail = google.gmail({ version: 'v1', auth: client });

        const raw = this.buildRawEmail({
            // Gmail API will use the authorized account regardless of From header,
            // but we set it explicitly to the connected Gmail address for clarity.
            // Fallback to 'me' which Gmail interprets as the authorized account.
            from: senderEmail ?? 'me',
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
            logger.info({ userId, to: opts.to, subject: opts.subject }, 'Email sent via Gmail API');
            return true;
        } catch (err: any) {
            if (err?.code === 401 || err?.response?.status === 401) {
                await userRepository.clearGoogleTokens(userId);
                logger.warn({ userId }, 'Gmail send failed (401) — tokens cleared');
                return false;
            }
            logger.error({ err, userId, to: opts.to }, 'Gmail API send error');
            throw err;
        }
    }

    /**
     * Build RFC 2822 MIME message and base64url encode it.
     */
    private buildRawEmail(opts: {
        from: string;
        to: string;
        subject: string;
        html: string;
        attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
    }): string {
        const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const hasAttachments = opts.attachments && opts.attachments.length > 0;

        let message = '';
        message += `From: ${opts.from}\r\n`;
        message += `To: ${opts.to}\r\n`;
        message += `Subject: ${opts.subject}\r\n`;
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

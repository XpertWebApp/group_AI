import { EmailSendResult } from './email/emailErrors';
export declare class GmailService {
    private createOAuth2Client;
    /**
     * Generate the Google consent URL for a user to connect their Gmail account.
     * The state parameter carries the userId so the callback knows who to store tokens for.
     *
     * Scopes:
     *  - gmail.send       — required to send emails on behalf of the user
     *  - userinfo.email   — required to fetch the connected Google account email address
     */
    getAuthUrl(state: string): string;
    /**
     * Exchange authorization code for tokens, encrypt and store them for the user.
     * Also fetches the connected Gmail address via gmail.users.getProfile and stores it,
     * so the frontend can display which Google account is connected.
     */
    handleCallback(code: string, userId: string): Promise<void>;
    /**
     * Get an authenticated OAuth2 client for a specific user.
     * Auto-refreshes expired tokens and persists the new access token.
     * Returns a discriminated union with a specific EmailFailure code on failure
     * so the caller can distinguish NOT_CONNECTED from TOKEN_REVOKED, etc.
     */
    private getAuthenticatedClient;
    /**
     * Check if a user has connected their Google account.
     */
    isConnected(userId: string): Promise<boolean>;
    /**
     * Get the connection status + connected Gmail address for a user.
     * Used by GET /api/v1/auth/google/status to populate the frontend display.
     */
    getConnectionStatus(userId: string): Promise<{
        connected: boolean;
        email: string | null;
    }>;
    /**
     * Disconnect — revoke token at Google and clear stored tokens.
     */
    disconnect(userId: string): Promise<void>;
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
    sendEmail(userId: string, opts: {
        to: string;
        subject: string;
        html: string;
        attachments?: Array<{
            filename: string;
            content: Buffer;
            contentType: string;
        }>;
    }): Promise<EmailSendResult>;
    /**
     * RFC 2047 MIME encoded-word for non-ASCII header values (e.g. subject lines
     * with em-dash, accented characters, emoji, etc.). Without this, Gmail sends
     * the raw UTF-8 bytes which most email clients render as Latin-1 mojibake.
     *
     * Format: =?UTF-8?B?<base64>?=
     * Pure-ASCII strings are returned unchanged so we don't waste bytes.
     */
    private encodeHeader;
    /**
     * Build RFC 2822 MIME message and base64url encode it.
     * If `from` is not provided, the From header is omitted and Gmail
     * will use the authorized account automatically.
     */
    private buildRawEmail;
}
declare const _default: GmailService;
export default _default;

/**
 * Email Failure Codes & Discriminated Union Result Types
 *
 * Replaces boolean returns from the email send pipeline with structured
 * results carrying a specific failure code. Every layer in the email send
 * chain (gmail.service → notification.service → proposals.service → controller)
 * preserves and forwards this code so the API response can tell the frontend
 * exactly what went wrong (e.g., "reconnect Gmail" vs "transient network").
 *
 * Design rules:
 *  - `failure.detail` is logger-only — NEVER return it in HTTP response bodies.
 *  - `failure.message` is user-safe and can be shown directly to admins.
 *  - `httpStatus` lets the controller pick the right HTTP code per failure
 *    (412 for "user must reconnect", 403 for Gmail forbidden, 502 for transient).
 */

export const EmailFailureCode = {
    /** No google_refresh_token in DB — user has not connected, or tokens were cleared. */
    NOT_CONNECTED: 'NOT_CONNECTED',
    /** decryptToken() threw — encryption key rotation, corrupted ciphertext, etc. */
    TOKEN_DECRYPT_FAILED: 'TOKEN_DECRYPT_FAILED',
    /** Refresh token returned `invalid_grant` — user revoked at Google or token expired beyond refresh. */
    TOKEN_REVOKED: 'TOKEN_REVOKED',
    /** Gmail API returned 401 — access token rejected (typically tokens auto-cleared after this). */
    GMAIL_UNAUTHORIZED: 'GMAIL_UNAUTHORIZED',
    /** Gmail API returned 403 — scope missing, daily quota, sender mismatch, or workspace policy. */
    GMAIL_FORBIDDEN: 'GMAIL_FORBIDDEN',
    /** Gmail API returned 400 — malformed MIME (likely our bug building the message). */
    GMAIL_BAD_REQUEST: 'GMAIL_BAD_REQUEST',
    /** Gmail API returned 5xx — Google upstream issue, retryable. */
    GMAIL_UPSTREAM: 'GMAIL_UPSTREAM',
    /** Network error reaching Google (ENOTFOUND/ECONNRESET/ETIMEDOUT). */
    GMAIL_NETWORK: 'GMAIL_NETWORK',
    /** Gmail API failed for an unknown reason — see `detail` in logs. */
    GMAIL_UNKNOWN: 'GMAIL_UNKNOWN',
    /** SMTP fallback was needed but SMTP is not configured (no SMTP_HOST env var). */
    SMTP_NOT_CONFIGURED: 'SMTP_NOT_CONFIGURED',
    /** SMTP transport.sendMail() threw. */
    SMTP_FAILED: 'SMTP_FAILED',
} as const;

export type EmailFailureCode = (typeof EmailFailureCode)[keyof typeof EmailFailureCode];

export interface EmailFailure {
    code: EmailFailureCode;
    /** User-safe message that can be displayed in the frontend or returned in HTTP body. */
    message: string;
    /** Technical detail for server logs only — NEVER include in HTTP response body. */
    detail?: string;
    /** True if a retry might succeed (transient errors, network issues). */
    retryable: boolean;
    /** True if the user must take an action (reconnect Gmail, contact admin, etc.). */
    userActionRequired: boolean;
    /** Suggested HTTP status code for the API response. */
    httpStatus: number;
}

/**
 * Discriminated union returned by every layer in the email send pipeline.
 * On success: `{ ok: true, method: 'gmail' | 'smtp' }`.
 * On failure: `{ ok: false, method, failure: EmailFailure }`.
 */
export type EmailSendResult =
    | { ok: true; method: 'gmail' | 'smtp' }
    | { ok: false; method: 'gmail' | 'smtp' | 'none'; failure: EmailFailure };

/**
 * Default values per failure code. Centralised so HTTP status, retry semantics,
 * and user-facing messages stay consistent across the codebase.
 */
const FAILURE_DEFAULTS: Record<EmailFailureCode, Omit<EmailFailure, 'code'>> = {
    NOT_CONNECTED: {
        message: 'Your Google account is not connected. Please connect Gmail in Settings to send offers.',
        retryable: false,
        userActionRequired: true,
        httpStatus: 412,
    },
    TOKEN_DECRYPT_FAILED: {
        message: 'Stored Google credentials could not be read. Please disconnect and reconnect your Google account.',
        retryable: false,
        userActionRequired: true,
        httpStatus: 412,
    },
    TOKEN_REVOKED: {
        message: 'Your Google account access was revoked. Please reconnect Gmail in Settings.',
        retryable: false,
        userActionRequired: true,
        httpStatus: 412,
    },
    GMAIL_UNAUTHORIZED: {
        message: 'Google rejected the credentials. Please reconnect Gmail in Settings.',
        retryable: false,
        userActionRequired: true,
        httpStatus: 412,
    },
    GMAIL_FORBIDDEN: {
        message: 'Google refused to send the email. This is usually a missing scope, exceeded quota, or sender mismatch — try disconnecting and reconnecting Gmail with full permissions.',
        retryable: false,
        userActionRequired: true,
        httpStatus: 403,
    },
    GMAIL_BAD_REQUEST: {
        message: 'The offer email could not be built. Please contact support.',
        retryable: false,
        userActionRequired: false,
        httpStatus: 500,
    },
    GMAIL_UPSTREAM: {
        message: 'Google is temporarily unavailable. Please try again in a moment.',
        retryable: true,
        userActionRequired: false,
        httpStatus: 502,
    },
    GMAIL_NETWORK: {
        message: 'Network error contacting Google. Please try again.',
        retryable: true,
        userActionRequired: false,
        httpStatus: 502,
    },
    GMAIL_UNKNOWN: {
        message: 'Sending via Gmail failed for an unknown reason. Please try again.',
        retryable: true,
        userActionRequired: false,
        httpStatus: 502,
    },
    SMTP_NOT_CONFIGURED: {
        message: 'Email could not be sent. SMTP fallback is not configured on the server.',
        retryable: false,
        userActionRequired: true,
        httpStatus: 412,
    },
    SMTP_FAILED: {
        message: 'Email could not be delivered via SMTP. Please try again.',
        retryable: true,
        userActionRequired: false,
        httpStatus: 502,
    },
};

/**
 * Build an EmailFailure with sensible defaults for the given code.
 * Pass `detail` for server-log diagnostics (e.g., the verbatim Gmail API error message).
 */
export function failure(code: EmailFailureCode, partial: Partial<EmailFailure> = {}): EmailFailure {
    return { code, ...FAILURE_DEFAULTS[code], ...partial };
}

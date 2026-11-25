/**
 * Email Failure Codes & Discriminated Union Result Types
 *
 * Replaces boolean returns from the email send pipeline with structured
 * results carrying a specific failure code. Every layer in the email send
 * chain (notification.service → proposals.service → controller) preserves
 * and forwards this code so the API response can tell the frontend exactly
 * what went wrong.
 *
 * Design rules:
 *  - `failure.detail` is logger-only — NEVER return it in HTTP response bodies.
 *  - `failure.message` is user-safe and can be shown directly to admins.
 *  - `httpStatus` lets the controller pick the right HTTP code per failure.
 */

export const EmailFailureCode = {
    /** SMTP is not configured (no SMTP_HOST env var). */
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
    /** True if the user must take an action (contact admin, etc.). */
    userActionRequired: boolean;
    /** Suggested HTTP status code for the API response. */
    httpStatus: number;
}

/**
 * Discriminated union returned by every layer in the email send pipeline.
 * On success: `{ ok: true, method: 'smtp' }`.
 * On failure: `{ ok: false, method, failure: EmailFailure }`.
 */
export type EmailSendResult =
    | { ok: true; method: 'smtp' }
    | { ok: false; method: 'smtp' | 'none'; failure: EmailFailure };

/**
 * Default values per failure code. Centralised so HTTP status, retry semantics,
 * and user-facing messages stay consistent across the codebase.
 */
const FAILURE_DEFAULTS: Record<EmailFailureCode, Omit<EmailFailure, 'code'>> = {
    SMTP_NOT_CONFIGURED: {
        message: 'Email could not be sent. SMTP is not configured on the server.',
        retryable: false,
        userActionRequired: true,
        httpStatus: 412,
    },
    SMTP_FAILED: {
        message: 'Email could not be delivered. Please try again.',
        retryable: true,
        userActionRequired: false,
        httpStatus: 502,
    },
};

/**
 * Build an EmailFailure with sensible defaults for the given code.
 * Pass `detail` for server-log diagnostics (e.g., the verbatim SMTP error message).
 */
export function failure(code: EmailFailureCode, partial: Partial<EmailFailure> = {}): EmailFailure {
    return { code, ...FAILURE_DEFAULTS[code], ...partial };
}

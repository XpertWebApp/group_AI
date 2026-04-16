/**
 * Date formatting utilities — European format (DD.MM.YYYY).
 *
 * All SETT partners use European date format per Oliver's requirement.
 * Use these helpers for any user-facing date display (PDFs, emails, UI responses).
 *
 * For internal/API data exchange, continue using ISO 8601 (YYYY-MM-DD).
 */
/**
 * Format a date as DD.MM.YYYY (European strict format).
 *
 * @param date - Date object, ISO string, or other Date-parseable value
 * @param fallback - Value to return if the input is null/invalid (default: 'N/A')
 *
 * Examples:
 *   formatDateEU('2026-04-14')                      → '14.04.2026'
 *   formatDateEU(new Date('2026-12-25T00:00:00Z'))  → '25.12.2026'
 *   formatDateEU(null)                              → 'N/A'
 *   formatDateEU('invalid')                         → 'N/A'
 */
export declare function formatDateEU(date: string | Date | null | undefined, fallback?: string): string;
/**
 * Format a check-in / check-out date range as DD.MM.YYYY – DD.MM.YYYY.
 *
 * Example:
 *   formatDateRangeEU('2026-04-14', '2026-04-18') → '14.04.2026 - 18.04.2026'
 */
export declare function formatDateRangeEU(from: string | Date | null | undefined, to: string | Date | null | undefined, separator?: string): string;
/**
 * Format a Date as DD.MM.YYYY HH:mm (for timestamps in logs / admin UI).
 */
export declare function formatDateTimeEU(date: string | Date | null | undefined, fallback?: string): string;

"use strict";
/**
 * Date formatting utilities — European format (DD.MM.YYYY).
 *
 * All SETT partners use European date format per Oliver's requirement.
 * Use these helpers for any user-facing date display (PDFs, emails, UI responses).
 *
 * For internal/API data exchange, continue using ISO 8601 (YYYY-MM-DD).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatDateEU = formatDateEU;
exports.formatDateRangeEU = formatDateRangeEU;
exports.formatDateTimeEU = formatDateTimeEU;
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
function formatDateEU(date, fallback = 'N/A') {
    if (!date)
        return fallback;
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime()))
        return fallback;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}.${month}.${year}`;
}
/**
 * Format a check-in / check-out date range as DD.MM.YYYY – DD.MM.YYYY.
 *
 * Example:
 *   formatDateRangeEU('2026-04-14', '2026-04-18') → '14.04.2026 - 18.04.2026'
 */
function formatDateRangeEU(from, to, separator = ' - ') {
    const f = formatDateEU(from);
    const t = formatDateEU(to);
    if (f === 'N/A' && t === 'N/A')
        return 'N/A';
    if (f === 'N/A')
        return t;
    if (t === 'N/A')
        return f;
    return `${f}${separator}${t}`;
}
/**
 * Format a Date as DD.MM.YYYY HH:mm (for timestamps in logs / admin UI).
 */
function formatDateTimeEU(date, fallback = 'N/A') {
    if (!date)
        return fallback;
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime()))
        return fallback;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}.${month}.${year} ${hours}:${minutes}`;
}

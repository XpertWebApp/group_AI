/**
 * Phone number parser — splits a phone string into country code + number.
 * Used by the webhook to parse incoming Wix phone strings, since Wix sends
 * a single combined string instead of separate fields.
 *
 * Strategy: longest-prefix match against a known list of E.164 country code prefixes.
 */
export interface ParsedPhone {
    countryCode: string | null;
    number: string;
}
/**
 * Parse a phone string into country code + number.
 * Removes spaces, dashes, parentheses before matching.
 *
 * Examples:
 *   "+36201234567"        → { countryCode: "+36", number: "201234567" }
 *   "+971 50 123 4567"    → { countryCode: "+971", number: "501234567" }
 *   "+1-234-567-8900"     → { countryCode: "+1", number: "2345678900" }
 *   "201234567"           → { countryCode: null, number: "201234567" }
 *   "+999123456"          → { countryCode: null, number: "+999123456" }  // unknown prefix
 *   ""                    → { countryCode: null, number: "" }
 */
export declare function parsePhoneWithCountryCode(input: string | null | undefined): ParsedPhone;
/**
 * Format a country code + number for display.
 * - If both present: "+36 201234567"
 * - If only number: "201234567"
 * - If neither: "-"
 */
export declare function formatPhoneWithCountryCode(countryCode: string | null | undefined, number: string | null | undefined): string;

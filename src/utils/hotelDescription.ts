/**
 * Hotel description language resolver.
 *
 * Picks the correct hotel description for a given language with the right
 * fallback order:
 *   1. GIATA text (sectionType '100' = Location summary) for the requested lang
 *   2. WBE metadata.Location  (English-only — synced from WBE CDN)
 *   3. WBE metadata.Description
 *   4. null
 *
 * Used by every endpoint that surfaces a hotel card / hotel detail to the FE.
 */

export type SupportedLang = 'en' | 'de';

export const DEFAULT_LANG: SupportedLang = 'en';

/** GIATA section type code for the short location summary. */
export const GIATA_LOCATION_SECTION = '100';

export interface ResolvedDescription {
    description: string | null;
    /** Which language the description is actually in. May differ from the requested lang on fallback. */
    descriptionLanguage: SupportedLang | null;
    /** Where the text came from — for debugging and a possible future "Translated by GIATA" badge. */
    descriptionSource: 'giata' | 'wbe' | null;
}

/**
 * Resolve a single hotel's description.
 *
 * @param giataText  GIATA text content for [hotelCode, lang, sectionType=100], or null/undefined if not synced.
 * @param wbeMetadata The hotel's `metadata` JSON column from the master.hotels table.
 * @param lang       The frontend's currently-selected language.
 */
export function resolveHotelDescription(
    giataText: string | null | undefined,
    wbeMetadata: Record<string, any> | null | undefined,
    lang: SupportedLang,
): ResolvedDescription {
    if (giataText) {
        return {
            description: giataText,
            descriptionLanguage: lang,
            descriptionSource: 'giata',
        };
    }

    const wbeText = wbeMetadata?.Location || wbeMetadata?.Description || null;
    if (wbeText) {
        // WBE metadata is currently English-only — flag the language as 'en'
        // even when the user asked for 'de' so the FE can show a "fallback" hint.
        return {
            description: String(wbeText),
            descriptionLanguage: 'en',
            descriptionSource: 'wbe',
        };
    }

    return {
        description: null,
        descriptionLanguage: null,
        descriptionSource: null,
    };
}

/** Coerce a free-form lang input to a supported value, defaulting to 'en'. */
export function normaliseLang(value: unknown): SupportedLang {
    return value === 'de' ? 'de' : 'en';
}

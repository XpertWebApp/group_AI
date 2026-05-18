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

/** Single-language description bundle returned inside `descriptions[lang]`. */
export interface DescriptionBundle {
    text: string | null;
    source: 'giata' | 'wbe' | null;
    /**
     * True when this language's text is actually a fallback in a different language
     * (e.g. WBE English shown under the `de` key because no German GIATA text exists).
     * FE can use this to render a "(translation unavailable)" hint.
     */
    isFallback: boolean;
}

/** All-languages description payload — FE indexes into `descriptions[currentLang]` on toggle. */
export interface MultiLangDescriptions {
    en: DescriptionBundle;
    de: DescriptionBundle;
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

/**
 * Resolve descriptions for BOTH supported languages at once.
 *
 * Used by search results and the View Details page so the FE has both
 * translations cached client-side — when the user toggles the language
 * switcher, the card text updates instantly without a fresh search.
 *
 * Per-language fallback: GIATA text in that language → WBE English metadata
 * (flagged as `isFallback: true` on the non-English slot).
 *
 * @param giataTextByLang  Map of lang → GIATA section-100 content; pass `null` for languages with no GIATA text.
 * @param wbeMetadata      The hotel's `metadata` JSON column.
 */
export function resolveMultiLangDescriptions(
    giataTextByLang: { en: string | null; de: string | null },
    wbeMetadata: Record<string, any> | null | undefined,
): MultiLangDescriptions {
    const wbeText = wbeMetadata?.Location || wbeMetadata?.Description || null;
    const wbeString = wbeText ? String(wbeText) : null;

    const buildBundle = (lang: SupportedLang): DescriptionBundle => {
        const giata = giataTextByLang[lang];
        if (giata) {
            return { text: giata, source: 'giata', isFallback: false };
        }
        if (wbeString) {
            return { text: wbeString, source: 'wbe', isFallback: lang !== 'en' };
        }
        return { text: null, source: null, isFallback: false };
    };

    return { en: buildBundle('en'), de: buildBundle('de') };
}

/** Pick the legacy single-language fields (`description` / `descriptionLanguage` / `descriptionSource`) out of the bundle. */
export function pickLegacyDescription(
    bundles: MultiLangDescriptions,
    lang: SupportedLang,
): ResolvedDescription {
    const b = bundles[lang];
    if (b.text === null) {
        return { description: null, descriptionLanguage: null, descriptionSource: null };
    }
    return {
        description: b.text,
        descriptionLanguage: b.isFallback ? 'en' : lang,
        descriptionSource: b.source,
    };
}

/**
 * Translation Service — DeepL API wrapper
 *
 * Translates dynamic user-entered text (customer notes, special requirements,
 * service names) for PDF generation. Static PDF labels are handled by the
 * i18n/pdfTranslations.ts dictionary — this service is only for free-form text.
 *
 * Requires env var: DEEPL_API_KEY
 *
 * Graceful degradation: if the API key is missing or the API call fails,
 * the original (untranslated) text is returned. The PDF is never blocked
 * by a translation failure.
 */
type SupportedLanguage = 'en' | 'de';
/**
 * Translate a single text string to the target language.
 *
 * Returns the original text if:
 *  - the text is empty/null
 *  - source and target language are the same
 *  - the API key is not configured
 *  - the API call fails for any reason
 */
export declare function translateText(text: string | null | undefined, targetLang: SupportedLanguage, sourceLang?: SupportedLanguage): Promise<string>;
/**
 * Translate multiple text strings in a single batch API call.
 * DeepL supports batch translation natively — more efficient than a loop.
 *
 * Returns an array in the same order as the input.
 * Any null/empty inputs are preserved as-is (not sent to the API).
 */
export declare function translateBatch(texts: (string | null | undefined)[], targetLang: SupportedLanguage, sourceLang?: SupportedLanguage): Promise<string[]>;
declare const _default: {
    translateText: typeof translateText;
    translateBatch: typeof translateBatch;
};
export default _default;

/**
 * Keyless machine translation for the WBE "Important Information"
 * (EssentialInfo) field — intentionally does NOT use DeepL (per instruction,
 * DeepL is reserved for other content). Uses the free `google-translate-api-x`
 * library (no API key, no per-character cost).
 *
 * Graceful degradation: on ANY failure the original (untranslated) texts are
 * returned, so a translation outage never blocks the response — same contract
 * as the DeepL service used elsewhere.
 */
import logger from './logger';

/**
 * Batch-translate `texts` from `from` to `to`. Returns an array in the same
 * order/length as the input; failed items fall back to their original string.
 */
export async function translateTextsFree(
    texts: string[],
    from: string,
    to: string,
): Promise<string[]> {
    if (texts.length === 0) return [];
    // Dynamic import — the library is ESM-only; this works from CommonJS.
    const { translate } = await import('google-translate-api-x');
    // Retry with backoff — the free endpoint occasionally rate-limits (429),
    // which would otherwise leave a hotel in English.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
            const res: any = await translate(texts as any, { from, to, forceBatch: true });
            const arr = Array.isArray(res) ? res : [res];
            return texts.map((t, i) => arr[i]?.text ?? t);
        } catch (err: any) {
            if (attempt < MAX_ATTEMPTS - 1) {
                await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
                continue;
            }
            logger.error(
                { err: err?.message, count: texts.length, from, to },
                'Free (google-translate-api-x) translation failed after retries — returning original texts',
            );
            return texts; // graceful fallback (English); caller must NOT cache these
        }
    }
    return texts;
}

export default { translateTextsFree };

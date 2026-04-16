"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.translateText = translateText;
exports.translateBatch = translateBatch;
const deepl = __importStar(require("deepl-node"));
const logger_1 = __importDefault(require("../utils/logger"));
/** DeepL uses specific language codes — map our simple codes to DeepL's format */
const DEEPL_TARGET_MAP = {
    en: 'en-GB',
    de: 'de',
};
const DEEPL_SOURCE_MAP = {
    en: 'en',
    de: 'de',
};
let translator = null;
/**
 * Lazily initialise the DeepL translator client.
 * Returns null if the API key is not configured.
 */
function getClient() {
    if (translator)
        return translator;
    const apiKey = process.env.DEEPL_API_KEY;
    if (!apiKey) {
        logger_1.default.warn('DEEPL_API_KEY is not set — dynamic translation disabled, original text will be used');
        return null;
    }
    translator = new deepl.Translator(apiKey);
    return translator;
}
/**
 * Translate a single text string to the target language.
 *
 * Returns the original text if:
 *  - the text is empty/null
 *  - source and target language are the same
 *  - the API key is not configured
 *  - the API call fails for any reason
 */
async function translateText(text, targetLang, sourceLang) {
    if (!text || text.trim().length === 0)
        return text ?? '';
    // No translation needed when source matches target
    if (sourceLang && sourceLang === targetLang)
        return text;
    const client = getClient();
    if (!client)
        return text;
    try {
        const result = await client.translateText(text, sourceLang ? DEEPL_SOURCE_MAP[sourceLang] : null, DEEPL_TARGET_MAP[targetLang]);
        return result.text;
    }
    catch (err) {
        logger_1.default.error({ err, targetLang, textLength: text.length }, 'DeepL API call failed — returning original text');
        return text;
    }
}
/**
 * Translate multiple text strings in a single batch API call.
 * DeepL supports batch translation natively — more efficient than a loop.
 *
 * Returns an array in the same order as the input.
 * Any null/empty inputs are preserved as-is (not sent to the API).
 */
async function translateBatch(texts, targetLang, sourceLang) {
    // If source === target, return as-is
    if (sourceLang && sourceLang === targetLang) {
        return texts.map((t) => t ?? '');
    }
    const client = getClient();
    if (!client)
        return texts.map((t) => t ?? '');
    // Separate non-empty texts that need translation from empty/null ones
    const indexMap = [];
    const toTranslate = [];
    for (let i = 0; i < texts.length; i++) {
        const t = texts[i];
        if (t && t.trim().length > 0) {
            indexMap.push(i);
            toTranslate.push(t);
        }
    }
    if (toTranslate.length === 0)
        return texts.map((t) => t ?? '');
    try {
        const results = await client.translateText(toTranslate, sourceLang ? DEEPL_SOURCE_MAP[sourceLang] : null, DEEPL_TARGET_MAP[targetLang]);
        // Merge translated results back into the output array
        const output = texts.map((t) => t ?? '');
        const translatedArr = Array.isArray(results) ? results : [results];
        for (let j = 0; j < indexMap.length; j++) {
            output[indexMap[j]] = translatedArr[j]?.text ?? toTranslate[j];
        }
        return output;
    }
    catch (err) {
        logger_1.default.error({ err, targetLang, batchSize: toTranslate.length }, 'DeepL batch call failed — returning original texts');
        return texts.map((t) => t ?? '');
    }
}
exports.default = { translateText, translateBatch };
//# sourceMappingURL=translation.service.js.map
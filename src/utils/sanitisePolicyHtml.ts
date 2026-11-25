/**
 * Policy-HTML sanitiser — shared by:
 *  - PUT /settings/policies   (save-path defence: trusted-only-after-this)
 *  - PDF rendering            (render-path defence: belt-and-braces)
 *
 * Whitelist + attribute rules come straight from `policies-rich-text-handover.md`
 * §2.3 (FE handover, Shamandeep, 2026-06-02). Any divergence from that doc is a
 * bug — keep this file aligned with whatever the FE editor emits.
 */
import sanitizeHtml, { IOptions } from 'sanitize-html';

/**
 * Max width/height we accept on a pasted `<img>` so a 4000-px screenshot
 * doesn't blow up the PDF layout (handover §6.5).
 */
const IMG_MAX_PX = 600;

const POLICY_HTML_OPTIONS: IOptions = {
    allowedTags: [
        'p', 'br',
        'b', 'strong',
        'i', 'em',
        'u',
        's', 'strike',
        'ul', 'ol', 'li',
        'a',
        'img',
        'div', 'span',
    ],
    allowedAttributes: {
        a: ['href', 'target', 'rel'],
        img: ['src', 'alt', 'width', 'height'],
        // text-align via inline style — locked down further in transformTags.
        div: ['style'],
        p: ['style'],
        span: ['style'],
    },
    // Only allow `text-align: <one of these>` on style. Anything else dropped.
    allowedStyles: {
        '*': {
            'text-align': [/^(left|center|right|justify)$/],
        },
    },
    // Reject `javascript:`, `file:`, and `data:` (except image data URIs on <img>).
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {
        img: ['http', 'https', 'data'],
    },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    // <a target="_blank" rel="noopener noreferrer"> on every link.
    transformTags: {
        a: (tagName, attribs) => ({
            tagName: 'a',
            attribs: {
                ...attribs,
                target: '_blank',
                rel: 'noopener noreferrer',
            },
        }),
        img: (tagName, attribs) => {
            const out: Record<string, string> = {};
            if (attribs.src) out.src = attribs.src;
            if (attribs.alt) out.alt = attribs.alt;
            // Clamp pasted dimensions so a 4000-px image doesn't break layout.
            const w = Number(attribs.width);
            const h = Number(attribs.height);
            if (Number.isFinite(w) && w > 0) out.width = String(Math.min(w, IMG_MAX_PX));
            if (Number.isFinite(h) && h > 0) out.height = String(Math.min(h, IMG_MAX_PX));
            return { tagName: 'img', attribs: out };
        },
    },
    // Reject any image data URI that isn't `data:image/*`.
    allowProtocolRelative: false,
    nonBooleanAttributes: [],
    // Drop unrecognised tags entirely (children's text content is preserved).
    disallowedTagsMode: 'discard',
    // Don't self-close <br> oddly; HTML5 form is fine.
    selfClosing: ['img', 'br'],
};

/**
 * Sanitise a fragment of policy HTML. Returns the cleaned HTML string.
 *
 * Use this on BOTH the save path (PUT /settings/policies) and the render path
 * (PDF builder). It is intentionally idempotent — re-running it on already
 * sanitised output is a no-op.
 */
export function sanitisePolicyHtml(input: string | null | undefined): string {
    if (input === null || input === undefined) return '';
    const raw = String(input);
    if (raw.trim() === '') return '';
    return sanitizeHtml(raw, POLICY_HTML_OPTIONS);
}

/**
 * Helper for the save path: returns true if the input had visible content but
 * the sanitiser stripped everything (i.e. admin posted 100 % disallowed markup).
 * The controller should reject with 400 INVALID_HTML in that case
 * (handover §3.1, point 4).
 */
export function isFullyStrippedByPolicy(input: string | null | undefined): boolean {
    if (input === null || input === undefined) return false;
    const raw = String(input);
    // Empty/whitespace-only input is NOT a "stripped" case — admins clear fields
    // legitimately. Only flag when there were tags or non-whitespace and
    // nothing survived sanitisation.
    const stripped = raw.replace(/<[^>]+>/g, '').trim();
    const hadAnyTag = /<[^>]+>/.test(raw);
    const hadAnyText = stripped.length > 0;
    if (!hadAnyTag && !hadAnyText) return false;
    const cleaned = sanitisePolicyHtml(raw);
    return cleaned.trim() === '';
}

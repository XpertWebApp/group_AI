/**
 * PDF Generation Service — SETT Hub Group Offer PDF
 *
 * 2026-06-02 — Redesigned per the FE handover at
 *   pdf-redesign-backend-handover.md
 *
 * The PDF is rendered by Puppeteer (headless Chrome) from an HTML/CSS
 * template that mirrors the React preview modal pixel-for-pixel. This is
 * the same approach the FE handover §1 recommended ("WeasyPrint,
 * wkhtmltopdf, Puppeteer/Playwright, Chromium-headless, any of them").
 *
 * Public API kept intact so all callers (proposals.service `previewPdf`,
 * `sendProposal`, `approveProposal`, `downloadPdf`, `downloadOfferPdf`)
 * continue to work without changes:
 *   - export function generateOfferPdf(data: OfferPdfData): Promise<Buffer>
 *   - export interface OfferPdfData, OfferHotel, OfferService
 *
 * Brand spec source of truth: SETT Brand Guidelines v2 + the FE preview
 * component at components/ui/ContractPreviewModal.tsx.
 */

import path from 'path';
import fs from 'fs';
import puppeteer, { Browser } from 'puppeteer';
import logger from '../utils/logger';
import { PdfLanguage, PdfTranslations, getPdfTranslations } from '../i18n/pdfTranslations';
import { sanitisePolicyHtml } from '../utils/sanitisePolicyHtml';

// ─── Types (PUBLIC — do not break the contract) ──────────────────────────────

export interface OfferHotel {
    hotelName: string;
    starRating: number | null;
    addressCity: string | null;
    addressCountry: string | null;
    /**
     * Room-type key from ProposalHotel.rooms (e.g. "standardDoubleBeds",
     * "single", "quadruple__sub_double"). The PDF renderer humanises this
     * via `humaniseRoomType()` before display, so the customer sees
     * "Standard Double Rooms" rather than the raw camelCase key.
     */
    roomType: string;
    /** Rooms of THIS type only — not the total across the hotel. */
    roomQty: number;
    /** Nights of THIS room-type stay (usually mirrors the trip nights). */
    nights: number;
    mealPlan: string;
    pricePerRoomPerNight: number;
    totalPrice: number;
    cancelDeadline: string | null;
    /** Stable per-hotel reference (SETT-{requestRef}-{NNN}). */
    hotelRef?: string | null;
    /**
     * SETTHub hotel-detail URL — same link the FE renders on the Add Hotel
     * card. When present, the hotel name becomes a PDF link the customer
     * can click to open the hotel page in their browser. Falls back to
     * plain text when null (legacy proposals).
     */
    sethubDetailsUrl?: string | null;
    /**
     * Pre-fetched hotel thumbnail as a `data:image/jpeg;base64,...` URI.
     * Inlined at PDF-build time so the PDF stays self-contained — the
     * customer's PDF viewer never reaches out to WBE to resolve the image.
     * Null when WBE has no image for the hotel; the hotel block then
     * renders without a thumbnail (graceful degradation).
     */
    hotelImageDataUri?: string | null;
    /**
     * Street address (first line). Combined with addressCity + addressCountry
     * to render the full location below the hotel name.
     */
    address?: string | null;
    /**
     * Short hotel description — sourced from GIATA (preferred, multi-lang)
     * with WBE static-data fallback. Rendered as ~2 lines below the
     * address; truncated client-side to keep card height manageable.
     */
    description?: string | null;
    /**
     * Top hotel facilities — pre-resolved facility names ordered by
     * importance (Internet, Restaurant, Air Conditioning first). Capped
     * at ~8 in the PDF to avoid wall-of-chip clutter.
     */
    facilities?: string[];
    /**
     * True when the option's price includes free cancellation until
     * `cancelDeadline`. Renders as a brand-green check badge on the
     * card — matches the FE Hotel Card treatment.
     */
    freeCancellation?: boolean | null;
}

export interface OfferService {
    serviceName: string;
    quantity: number;
    days: number;
    unitPrice: number;
    totalPrice: number;
}

export interface OfferPdfData {
    // Company (from settings — currently displayed, but the new PDF design
    // uses hard-coded SETT supplier details per the FE handover §6.2.
    // Kept on the type for backward-compat with non-redesign callers.)
    companyName: string;
    companyAddress: string;
    companyPhone: string;
    companyPhoneCountryCode?: string | null;
    companyEmail: string;
    companyWebsite: string;
    companyTaxId: string;
    assignedPerson: string;

    // Client
    referenceNumber: number;
    contactName: string;
    companyNameClient: string;
    contactEmail: string;
    contactPhone: string;
    contactPhoneCountryCode?: string | null;

    // Trip
    destinationName: string;
    checkinDate: string;
    checkoutDate: string;
    nights: number;
    /** Optional total guest count for the trip-details GUESTS column. */
    groupSize?: number | null;
    /** Optional explicit address (matches BookingRequest.hotelLocation in FE spec). */
    hotelLocation?: string | null;

    // Hotels & Services
    hotels: OfferHotel[];
    services: OfferService[];

    // Notes & Policies
    specialRequirements: string | null;
    customerNotes: string | null;
    cancellationConditions: string | null;
    termsAndConditions: string | null;
    /**
     * Customer payment deadline — staff-set on the proposal (no automatic
     * default). When present, rendered as a "Payment due by DD MMM YYYY"
     * line in the policies/cancellation section so the customer knows
     * when they must pay. Null when unset; the renderer simply omits the
     * line in that case (but the Send Offer flow blocks sending when
     * null, so a real customer-facing PDF should always have it set).
     */
    paymentDeadline?: string | null;

    // Totals
    currency: string;
    totalPrice: number;
    sellingPricePerRoomPerNight: number;
    totalRooms: number;

    // Language (defaults to 'en')
    language?: PdfLanguage;

    /**
     * IANA timezone of the viewer (e.g. "Asia/Kolkata", "Europe/Berlin"),
     * forwarded by the frontend so the free-cancellation deadline in the PDF
     * matches the date shown in the on-screen Offer Preview. Only affects the
     * cancel-deadline badge; when omitted the deadline is formatted in UTC.
     */
    timezone?: string | null;

    /**
     * ISO creation date of the offer/proposal, used for the document date in
     * the PDF header (and the year in the "506/2026" document number). Set to
     * the proposal's `createdAt` so the PDF shows the SAME date as the
     * on-screen Offer Preview and stays stable on re-download, instead of
     * drifting to the render date. When omitted, falls back to "now".
     */
    documentDate?: string | null;
}

// ─── SETT supplier hard-codes (FE handover §6.2 / §6.7) ──────────────────────
// TODO(settings): move these to the Settings model when we add a Company-Info
// admin page. The FE hard-codes them today; we mirror the values 1:1.

const SETT_SUPPLIER = {
    companyName: 'S-E-T-T WORLDWIDE RESERVATION FZE',
    assignedPerson: 'Vincent Riefler',
    email: 'vincent@s-e-t-t.com',
    phone: '+45 32 74 93 16',
    address: 'Fujairah Creative Tower, P.O. Box 4422, Fujairah, UAE',
    taxId: '1001233897',
};

const SETT_BANK = {
    bankName: 'Emirates NBD',
    accountHolder: 'S-E-T-T Worldwide Reservation FZE',
    iban: 'AE12 0260 0010 1234 5678 901',
    swiftBic: 'EBILAEAD',
};

/** Hard-coded on the FE today — will move to a config field. */
const ISSUED_BY = 'Oliver Riefler';

// ─── Asset resolution ────────────────────────────────────────────────────────

/**
 * Resolve a `public/assets/<filename>` path across the cwd shapes the app
 * boots from (dev: src/services + cwd=server, prod: dist/services + cwd=server).
 */
function resolveAsset(filename: string): string | null {
    const candidates = [
        path.resolve(process.cwd(), 'public', 'assets', filename),
        path.resolve(__dirname, '..', '..', 'public', 'assets', filename),
        path.resolve(__dirname, '..', '..', '..', 'public', 'assets', filename),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/**
 * Read the brand-spec 24H Group Offer logo and inline it as a base64
 * data URI. Per Brand Guidelines v2 §4.2: "Group offer documents
 * generated by the AI tool" MUST use the `Group-offer--big-2.png` mark
 * (which lives on disk as `group-offer-header.png`). This replaces the
 * generic SETT Groups SVG we used before — the FE handover specified a
 * "white SETT logo" generically; the brand guide is more specific and
 * overrides.
 *
 * The transparent variant (`group-offer-header-transparent.png`) is
 * preferred so the navy header background shows through the gaps in the
 * mark. Falls back to the opaque PNG if the transparent variant is
 * missing.
 */
function getInlineLogoDataUri(): string {
    const transparent = resolveAsset('group-offer-header-transparent.png');
    const fallback = resolveAsset('group-offer-header.png');
    const p = transparent ?? fallback;
    if (!p) {
        // Last-resort 1×1 transparent PNG so the <img> tag doesn't break.
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    }
    const bytes = fs.readFileSync(p);
    return `data:image/png;base64,${bytes.toString('base64')}`;
}

/**
 * Footer logo — the SETT umbrella mark for the navy footer band.
 *
 * Asset choice: the S-E-T-T Groups wordmark uses black text on a
 * transparent background, which becomes invisible on the navy band.
 * The umbrella mark uses brand-green lettering (with green sub-text)
 * which reads cleanly on navy.
 *
 * The transparent-bg variant (`sett-umbrella-logo-transparent.png`)
 * was generated from the white-bg source with ImageMagick:
 *   convert sett-umbrella-logo.png -fuzz 5% -transparent white
 *           sett-umbrella-logo-transparent.png
 * Falls back to the white-bg original if the transparent variant
 * isn't present (e.g. fresh checkout before the asset is committed).
 *
 * Same inline-data-URI approach as the header logo so the PDF stays
 * self-contained for emailed delivery.
 */
function getInlineFooterLogoDataUri(): string {
    const transparent = resolveAsset('sett-umbrella-logo-transparent.png');
    const fallback = resolveAsset('sett-umbrella-logo.png');
    const p = transparent ?? fallback;
    if (!p) {
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    }
    const bytes = fs.readFileSync(p);
    return `data:image/png;base64,${bytes.toString('base64')}`;
}

// ─── Formatters ──────────────────────────────────────────────────────────────

/** EU dotted date: dd.mm.yyyy. Returns "—" when input is missing/invalid. */
function formatDateEU(dateStr: string | null | undefined): string {
    if (!dateStr) return '—';
    try {
        const d = new Date(dateStr);
        if (Number.isNaN(d.getTime())) return '—';
        // Use UTC accessors so the displayed date doesn't shift with the
        // renderer host's timezone. Checkin/checkout dates and payment
        // deadlines are stored as end-of-day UTC (or as bare YYYY-MM-DD
        // which JS parses as UTC midnight); rendering via getDate() /
        // getMonth() / getFullYear() would silently bump those to the
        // "day before" on any server west of UTC. Matches the
        // convention already used by formatCancelDeadlineEU() (line 418).
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
    } catch {
        return '—';
    }
}

/** EU style: 2.484,00 (period thousands, comma decimal). */
function formatPriceEU(n: number | null | undefined): string {
    const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
    // "2,484.00" → swap to "2.484,00" via placeholder.
    const intl = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return intl.replace(/,/g, 'X').replace(/\./g, ',').replace(/X/g, '.');
}

/** Strip HTML tags from a free-text field for safe use inside attribute text. */
function escapeHtml(s: string | null | undefined): string {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * HTML sanitiser for `cancellationConditions` / `termsAndConditions` rich text.
 *
 * Delegates to the shared `sanitisePolicyHtml` helper so the render-path
 * whitelist stays in lockstep with the save-path whitelist
 * (PUT /settings/policies). Whitelist + attribute rules per
 * `policies-rich-text-handover.md` §2.3.
 *
 * Belt-and-braces: even though save-time sanitisation already ran, we sanitise
 * again on render so the PDF can never emit untrusted HTML. Re-sanitising
 * already-clean input is a no-op.
 */
function sanitiseRichText(html: string | null | undefined): string {
    return sanitisePolicyHtml(html);
}

// ─── Section: HTML helpers ───────────────────────────────────────────────────

/** Inline-bold key/value MetaRow. */
function metaRow(label: string, value: string): string {
    return `
        <div class="meta-row">
            <div class="k">${escapeHtml(label)}</div>
            <div class="v">${escapeHtml(value) || '—'}</div>
        </div>`;
}

/** Translate a meal-plan code (BB / RO / HB / FB / AI) into the brand label. */
function mealPlanLabel(code: string | null | undefined, t: PdfTranslations): string {
    const upper = String(code ?? '').toUpperCase().trim();
    switch (upper) {
        case 'BB': return t.mealBreakfast;
        case 'RO': return t.mealRoomOnly;
        case 'HB': return t.mealHalfBoard;
        case 'FB': return t.mealFullBoard;
        case 'AI': return t.mealAllInclusive;
        default:   return upper ? upper : '';
    }
}

/**
 * Humanise a room-type JSON key into a customer-facing label.
 *
 *   "single"                → "Single"
 *   "twin"                  → "Twin"
 *   "double"                → "Double"
 *   "triple"                → "Triple"
 *   "quadruple"             → "Quadruple"
 *   "suites"                → "Suite"
 *   "standardDoubleBeds"    → "Standard Double Rooms"
 *   "twinBeds"              → "Twin Beds"
 *   "quadruple__sub_double" → "Quadruple Sub Double"
 *
 * Falls back to a Title-cased version of the raw key when no explicit
 * mapping exists, so future room-type keys auto-resolve to something
 * presentable without a code change.
 */
function humaniseRoomType(
    key: string | null | undefined,
    t?: PdfTranslations,
): string {
    if (!key) return '—';
    const raw = String(key).trim();
    // Prefer the localised label from the active translation dictionary —
    // this is what makes German PDFs render "Standard-Doppelzimmer"
    // instead of the camelCase "standardDoubleBeds" or English fallback
    // "Standard Double Rooms".
    const localised = t?.roomTypes?.[raw];
    if (localised) return localised;
    // Generic fallback — split camelCase + snake_case / double-underscore and
    // Title-case each word. e.g. "junior_suite" → "Junior Suite",
    // "presidentialSuite" → "Presidential Suite". Used when a brand-new
    // room-type key from WBE / GIATA hasn't been added to the dictionary
    // yet; reads naturally in English and is at least not raw camelCase
    // in any other language until someone adds the translation.
    return raw
        .replace(/[_]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .replace(/(^|\s)\S/g, (m) => m.toUpperCase())
        .trim();
}

/** Render a star rating as filled + empty stars, brand-green tint. */
function renderStars(rating: number | null | undefined): string {
    const n = Number(rating);
    if (!Number.isFinite(n) || n <= 0) return '';
    const full = Math.max(0, Math.min(5, Math.round(n)));
    const empty = 5 - full;
    return `<span class="star-rating" aria-label="${full} star">${'★'.repeat(full)}${'☆'.repeat(empty)}</span>`;
}

/**
 * Format a full address — street, city, country — into a single line.
 * Omits any of the three parts that are missing without leaving stray
 * commas. Returns an empty string when every part is missing so the
 * caller can hide the address row entirely.
 */
function formatFullAddress(
    street: string | null | undefined,
    city: string | null | undefined,
    country: string | null | undefined,
): string {
    const parts = [street, city, country]
        .map((p) => (p ?? '').trim())
        .filter((p) => p.length > 0);
    return parts.join(', ');
}

/**
 * Truncate a description to ~ N characters at a word boundary so the
 * card stays compact. Appends a single ellipsis when truncation
 * actually clipped content. Returns the original string when it fits.
 */
function clampDescription(text: string | null | undefined, maxChars = 220): string {
    if (!text) return '';
    const t = String(text).replace(/\s+/g, ' ').trim();
    if (t.length <= maxChars) return t;
    const slice = t.slice(0, maxChars);
    const lastSpace = slice.lastIndexOf(' ');
    return (lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd() + '…';
}

/**
 * Format the cancellation deadline date as EU "11.10.2026". Returns an
 * empty string when missing.
 *
 * Unlike checkin/checkout (date-only, end-of-day UTC), the cancel deadline
 * carries a real time-of-day from the supplier (e.g. `2026-10-20T19:59:59Z`,
 * which is 23:59:59 on the 20th in Dubai / UTC+4, but rolls to the 21st in
 * UTC+5 and later). To keep the PDF's badge in sync with the on-screen Offer
 * Preview — which the frontend renders in the *viewer's browser timezone* —
 * we format in `timezone` (an IANA name the FE passes through). When no
 * timezone is supplied (or it's invalid) we fall back to UTC, preserving the
 * previous behaviour for any caller that doesn't send one.
 */
function formatCancelDeadlineEU(iso: string | null | undefined, timezone?: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';

    if (timezone) {
        try {
            const parts = new Intl.DateTimeFormat('en-GB', {
                timeZone: timezone,
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
            }).formatToParts(d);
            const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
            const dd = get('day');
            const mm = get('month');
            const yyyy = get('year');
            if (dd && mm && yyyy) return `${dd}.${mm}.${yyyy}`;
        } catch {
            // Invalid IANA timezone string — fall through to UTC below.
        }
    }

    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    return `${dd}.${mm}.${yyyy}`;
}

/**
 * Hotel card — single visual unit per hotel.
 *
 * Layout (top to bottom inside the card):
 *  1. HEADER STRIP: image on the left (160×120, optional), metadata
 *     column on the right (hotel name → star rating → location →
 *     meal-plan chip), reservation ref top-right.
 *  2. PRICING TABLE: room-type breakdown with sell/qty/nights/total,
 *     subtotal row at the bottom.
 *
 * Pagination: cards are designed to ALLOW breaking across pages when a
 * card is too tall to fit in the remaining space — strict
 * `page-break-inside: avoid` causes huge empty gaps when the engine
 * defers a card to the next page. Instead we keep the header strip
 * together with the first table row (orphans/widows + page-break-after
 * hints) so a card never has its header orphaned at the bottom of a page.
 */
function renderHotelBlock(
    h: OfferHotel,
    rows: OfferHotel[],
    t: PdfTranslations,
    currency: string,
    timezone?: string | null,
): string {
    const symbol = currency === 'EUR' ? '€' : currency + ' ';
    const ref = h.hotelRef ?? null;

    let subtotal = 0;
    const rowsHtml = rows
        .map((r) => {
            // Row total = sell × qty × nights. Each room-type row carries
            // its own nights value (usually mirrors trip nights, but
            // ProposalHotel.rooms allows per-type variation).
            const nights = Math.max(1, r.nights ?? 1);
            const total = (r.pricePerRoomPerNight ?? 0) * (r.roomQty ?? 0) * nights;
            subtotal += total;
            return `
                <div class="row">
                    <div class="col flex">${escapeHtml(humaniseRoomType(r.roomType, t))}</div>
                    <div class="col w80">${symbol}${formatPriceEU(r.pricePerRoomPerNight)}</div>
                    <div class="col w55">${r.roomQty ?? 0}</div>
                    <div class="col w65">${nights}</div>
                    <div class="col w100 bold">${symbol}${formatPriceEU(total)}</div>
                </div>`;
        })
        .join('');

    const nameHtml = h.sethubDetailsUrl
        ? `<a class="hotel-name" href="${escapeHtml(h.sethubDetailsUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(h.hotelName || '—')}</a>`
        : `<span class="hotel-name">${escapeHtml(h.hotelName || '—')}</span>`;

    const starsHtml = renderStars(h.starRating);
    const fullAddress = formatFullAddress(h.address, h.addressCity, h.addressCountry);
    const description = clampDescription(h.description);
    const meal = mealPlanLabel(h.mealPlan, t);

    // Brand-priority chip row: meal plan first (most important commercial
    // fact), then up to 3 facility names from the enrichment helper.
    // Per product call — keep the row to a single line so the card stays
    // compact and consistent across hotels.
    const chipList: string[] = [];
    if (meal) chipList.push(meal);
    if (h.facilities?.length) {
        for (const f of h.facilities) {
            if (chipList.length >= 4) break; // 1 meal + 3 facilities
            if (f && !chipList.includes(f)) chipList.push(f);
        }
    }
    const chipsHtml = chipList.length
        ? `<div class="hotel-card-tags">${chipList.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('')}</div>`
        : '';

    // Free-cancellation badge — top-right of the card header, matches FE
    // Hotel Card. Only renders when ProposalHotel.freeCancellation is true.
    const cancelDate = formatCancelDeadlineEU(h.cancelDeadline, timezone);
    const cxlBadgeHtml = h.freeCancellation
        ? `<div class="cxl-badge" aria-label="${escapeHtml(t.freeCancellation)}">
                <div class="cxl-badge-title">✓ ${escapeHtml(t.freeCancellation)}</div>
                ${cancelDate ? `<div class="cxl-badge-sub">${escapeHtml(t.cancelBefore)} ${cancelDate}</div>` : ''}
            </div>`
        : '';

    return `
        <div class="hotel-card">
            <div class="hotel-card-header">
                ${h.hotelImageDataUri ? `<img class="hotel-thumb" src="${h.hotelImageDataUri}" alt="">` : '<div class="hotel-thumb-empty" aria-hidden="true"></div>'}
                <div class="hotel-card-meta">
                    <div class="hotel-card-name-row">
                        <div class="hotel-card-name-stack">
                            ${nameHtml}
                            ${starsHtml ? `<div class="hotel-card-stars">${starsHtml}</div>` : ''}
                        </div>
                        ${cxlBadgeHtml}
                    </div>
                    ${fullAddress ? `<div class="hotel-card-location"><span class="pin">📍</span> ${escapeHtml(fullAddress)}</div>` : ''}
                    ${description ? `<div class="hotel-card-desc">${escapeHtml(description)}</div>` : ''}
                    ${chipsHtml}
                </div>
            </div>
            <div class="tbl hotel-card-table">
                <div class="thead">
                    <div class="col flex">${escapeHtml(t.roomTypeCol)}</div>
                    <div class="col w80">${escapeHtml(t.sell)}</div>
                    <div class="col w55">${escapeHtml(t.qty)}</div>
                    <div class="col w65">${escapeHtml(t.nights)}</div>
                    <div class="col w100">${escapeHtml(t.total)}</div>
                </div>
                ${rowsHtml}
                <div class="subtotal">
                    <span class="lbl">${escapeHtml(t.subtotal)}</span>
                    <span class="val">${symbol}${formatPriceEU(subtotal)}</span>
                </div>
            </div>
            ${ref ? `<div class="hotel-card-footer"><span class="hotel-ref"><b>${escapeHtml(t.reservationRef)}</b> ${escapeHtml(ref)}</span></div>` : ''}
        </div>`;
}

/** Section 6.4 — Hotel Details. Groups OfferHotel entries by hotelName. */
function renderHotelDetails(
    hotels: OfferHotel[],
    t: PdfTranslations,
    currency: string,
    timezone?: string | null,
): string {
    if (!hotels?.length) return '';

    // Group OfferHotel rows by hotelName so a hotel with multiple room types
    // collapses into ONE block with multiple table rows.
    const groups = new Map<string, OfferHotel[]>();
    for (const h of hotels) {
        const key = h.hotelName ?? '—';
        const arr = groups.get(key) ?? [];
        arr.push(h);
        groups.set(key, arr);
    }

    const blocks = Array.from(groups.values())
        .map((rows) => renderHotelBlock(rows[0], rows, t, currency, timezone))
        .join('');

    return `
        <div class="section section-hotels">
            <h3>${escapeHtml(t.hotelDetails)}</h3>
            ${blocks}
        </div>`;
}

/** Section 6.5 — Service Details. */
function renderServiceDetails(
    services: OfferService[],
    t: PdfTranslations,
    currency: string,
): string {
    if (!services?.length) return '';
    const symbol = currency === 'EUR' ? '€' : currency + ' ';
    let subtotal = 0;
    const rowsHtml = services
        .map((s) => {
            const total = (s.unitPrice ?? 0) * (s.quantity ?? 0) * (s.days ?? 1);
            subtotal += total;
            return `
                <div class="row">
                    <div class="col flex">${escapeHtml(s.serviceName || '—')}</div>
                    <div class="col w130 grey">—</div>
                    <div class="col w55">${s.quantity ?? 0}</div>
                    <div class="col w80">${symbol}${formatPriceEU(s.unitPrice)}</div>
                    <div class="col w100 bold">${symbol}${formatPriceEU(total)}</div>
                </div>`;
        })
        .join('');

    return `
        <div class="section">
            <h3>${escapeHtml(t.serviceDetails)}</h3>
            <div class="tbl">
                <div class="thead">
                    <div class="col flex">${escapeHtml(t.service)}</div>
                    <div class="col w130">${escapeHtml(t.date)}</div>
                    <div class="col w55">${escapeHtml(t.qty)}</div>
                    <div class="col w80">${escapeHtml(t.sell)}</div>
                    <div class="col w100">${escapeHtml(t.total)}</div>
                </div>
                ${rowsHtml}
                <div class="subtotal">
                    <span class="lbl">${escapeHtml(t.subtotal)}</span>
                    <span class="val">${symbol}${formatPriceEU(subtotal)}</span>
                </div>
            </div>
        </div>`;
}

// ─── Main template ───────────────────────────────────────────────────────────

function buildOfferHtml(data: OfferPdfData): string {
    const lang = data.language ?? 'en';
    const t = getPdfTranslations(lang);
    const symbol = data.currency === 'EUR' ? '€' : data.currency + ' ';

    // Document metadata — use the offer/proposal creation date (stable) rather
    // than the render date, so the PDF header matches the on-screen Offer
    // Preview and doesn't jump to "today" every time the PDF is re-generated.
    const docDateIso = data.documentDate ?? new Date().toISOString();
    const docDateObj = new Date(docDateIso);
    const docYear = Number.isNaN(docDateObj.getTime())
        ? new Date().getFullYear()
        : docDateObj.getUTCFullYear();
    const documentCode = `${data.referenceNumber}/${docYear}`;
    const createdAt = formatDateEU(docDateIso);

    // Customer block
    const customerName = data.contactName?.trim()
        || data.companyNameClient?.trim()
        || '—';
    // Show the customer phone WITH its country-code prefix (e.g. "+44 7876…")
    // so the PDF matches the on-screen Offer Preview.
    const customerPhone = data.contactPhoneCountryCode
        ? `${data.contactPhoneCountryCode} ${data.contactPhone}`
        : (data.contactPhone || '—');

    // Compute grand total from the hotel + service rows so it matches what
    // the tables visibly add up to. (data.totalPrice may be stale on legacy
    // rows.)
    //
    // The hotel-row formula MUST include nights — each row's visible total
    // is `sell × qty × nights` (see renderHotelBlock line 465), and the
    // per-hotel Subtotal is the sum of those row totals. Skipping `nights`
    // here produced a Grand Total that was `subtotal ÷ nights` (QA report
    // 2026-06-27: subtotal €10,688.00 but grand total €3,648.00 — 4-night
    // stay, 1/4 of the correct figure).
    //
    // Each hotel row carries its OWN `nights` value (usually the trip
    // nights, but ProposalHotel.rooms allows per-type variation), so we
    // multiply per-row, not by a single trip-level `data.nights`.
    const hotelsTotal = (data.hotels ?? []).reduce(
        (acc, h) => {
            const nights = Math.max(1, h.nights ?? 1);
            return acc + ((h.pricePerRoomPerNight ?? 0) * (h.roomQty ?? 0) * nights);
        },
        0,
    );
    const servicesTotal = (data.services ?? []).reduce(
        (acc, s) => acc + ((s.unitPrice ?? 0) * (s.quantity ?? 0) * (s.days ?? 1)),
        0,
    );
    const grandTotal = hotelsTotal + servicesTotal;

    // Payment due date.
    //
    // Precedence:
    //   1. `data.paymentDeadline` — staff-set on the proposal via the new
    //      PATCH /api/v1/proposals/:id/payment-deadline endpoint. This is
    //      the customer-facing date and the Send Offer flow refuses to
    //      send without it set.
    //   2. Legacy fallback: checkoutDate − 30 days. Kept ONLY for backward
    //      compatibility with proposals created before the payment-deadline
    //      field shipped. Once the legacy backlog is drained this can be
    //      removed and the renderer should bail out with '—' instead.
    let paymentDue = '—';
    if (data.paymentDeadline) {
        const pd = new Date(data.paymentDeadline);
        if (!Number.isNaN(pd.getTime())) {
            paymentDue = formatDateEU(pd.toISOString());
        }
    } else if (data.checkoutDate) {
        const co = new Date(data.checkoutDate);
        if (!Number.isNaN(co.getTime())) {
            const d = new Date(co.getTime() - 30 * 24 * 60 * 60 * 1000);
            paymentDue = formatDateEU(d.toISOString());
        }
    }

    const logoSrc = getInlineLogoDataUri();
    const footerLogoSrc = getInlineFooterLogoDataUri();
    const hotelDetailsHtml = renderHotelDetails(data.hotels, t, data.currency, data.timezone);
    const serviceDetailsHtml = renderServiceDetails(data.services, t, data.currency);

    // ── Policy blocks ───────────────────────────────────────────────────
    // Source is `/settings/policies` (live) with the per-request snapshot
    // as a legacy fallback — resolved upstream in
    // `proposals.service::buildPdfData`. By the time we render, the
    // language has already been picked. Each block renders only when its
    // chosen variant has content; the section heading is omitted otherwise
    // so we never show an empty title (handover §6.1).
    //
    // Belt-and-braces: even though the save endpoint sanitises, the render
    // path re-runs `sanitiseRichText` so the PDF can never emit untrusted
    // markup. Idempotent on already-clean input.
    const cancellationHtml = data.cancellationConditions
        ? `<div class="section cancellation">
            <h3>${escapeHtml(t.cancellationConditions)}</h3>
            <div class="policy-html">${sanitiseRichText(data.cancellationConditions)}</div>
        </div>`
        : '';

    const termsHtml = data.termsAndConditions
        ? `<div class="section terms">
            <h3>${escapeHtml(t.termsAndConditions)}</h3>
            <div class="policy-html">${sanitiseRichText(data.termsAndConditions)}</div>
        </div>`
        : '';

    // ── HTML body ────────────────────────────────────────────────────────
    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --navy:#071C42;
    --green:#AAC737;
    --green-dark:#7A9420;
    --green-light:#C8E050;
    --grey:#686868;
    --border:#E0E0E0;
    --row-alt:#F8F9FA;
    --pill:#F5F9E8;
  }
  /* Full-bleed left/right/top (navy header + green bands run edge-to-edge),
     but reserve 140px at the BOTTOM for the running footerTemplate. Without
     this, Chrome lets body content flow into the footer band and the footer
     paints ON TOP of it — clipping whatever lands there (e.g. the IBAN /
     SWIFT rows of the payment table). A bare margin:0 here silently overrides
     the margin.bottom passed to page.pdf(), so the reserve MUST be on @page. */
  @page { size: A4 portrait; margin: 0 0 140px 0; }
  html, body {
    margin: 0;
    padding: 0;
    font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: var(--navy);
    -webkit-font-smoothing: antialiased;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .doc { background: #fff; }

  /* ── Header (§6.1) ─────────────────────────────────────────────────── */
  .doc-header {
    background: var(--navy);
    padding: 24px 32px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .doc-header .logo {
    /* Brand-spec 24H Group Offer logo (Brand Guidelines v2 §4.2).
       Multi-tone artwork (green "SETT" + olive band + white tagline);
       NO colour filter — the logo's own palette is correct against the
       navy header. Height tuned so the integrated "-24 H GROUP OFFER"
       band reads clearly without dominating the navy bar. */
    height: 56px;
    width: auto;
    display: block;
  }
  .doc-header .meta { text-align: right; }
  .doc-header .meta .label {
    color: var(--green);
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .doc-header .meta .docno {
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    margin-top: 4px;
  }
  .doc-header .meta .date {
    color: rgba(255, 255, 255, 0.85);
    font-size: 12px;
    margin-top: 4px;
  }
  .accent-bar { height: 3px; background: var(--green); }

  /* ── Section base ──────────────────────────────────────────────────── */
  .section {
    padding: 24px 32px;
    border-bottom: 1px solid var(--border);
    page-break-inside: avoid;
  }
  /* The hotel-details section can be tall (1 card per hotel, ~280 px
     each at 4-hotel proposals). Don't strict-keep it on one page —
     individual cards manage their own pagination via the hotel-card
     rules. Without this override, a 4-hotel section would block-break
     to page 2 leaving page 1 mostly empty. */
  .section.section-hotels { page-break-inside: auto; }
  .section.section-hotels h3 { page-break-after: avoid; }
  .section h3 {
    color: var(--navy);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin: 0 0 16px;
  }
  .label-sm {
    color: var(--green);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 12px;
  }

  /* ── Two-column / Three-column metadata grid (§6.2 / §6.3) ─────────── */
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
  }
  .grid-3 {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 24px;
  }
  .meta-name {
    color: var(--navy);
    font-size: 14px;
    font-weight: 700;
    margin-bottom: 8px;
  }
  .meta-row + .meta-row { margin-top: 6px; }
  .meta-row .k {
    color: var(--grey);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .meta-row .v {
    color: var(--navy);
    font-size: 13px;
    margin-top: 2px;
  }

  /* ── Tables (§6.4 / §6.5) ──────────────────────────────────────────── */
  .tbl {
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
    page-break-inside: avoid;
  }
  .tbl .thead {
    background: var(--navy);
    display: flex;
    padding: 12px 16px;
  }
  .tbl .thead .col {
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .tbl .row {
    display: flex;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }
  .tbl .row:first-of-type { border-top: none; }
  .tbl .row .col { color: var(--navy); font-size: 13px; }
  .tbl .row .col.bold { font-weight: 700; }
  .tbl .row .col.grey { color: var(--grey); font-size: 12px; }
  .tbl .subtotal {
    display: flex;
    justify-content: flex-end;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    background: var(--row-alt);
  }
  .tbl .subtotal .lbl {
    color: var(--grey);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin-right: 16px;
    align-self: center;
  }
  .tbl .subtotal .val {
    color: var(--navy);
    font-size: 14px;
    font-weight: 700;
    width: 100px;
    text-align: right;
  }

  .col.flex { flex: 1; text-align: left; }
  .col.w80  { width: 80px;  text-align: right; }
  .col.w55  { width: 55px;  text-align: center; }
  .col.w65  { width: 65px;  text-align: center; }
  .col.w100 { width: 100px; text-align: right; }
  .col.w130 { width: 130px; text-align: center; }

  /* ── Hotel card (§6.4 — redesigned) ─────────────────────────────────
     Each hotel renders as ONE cohesive card:
     - Header strip: 160x120 image + metadata column (name, stars,
       location, meal-plan chip) + reservation ref top-right
     - Pricing table: room-type breakdown with subtotal
     The card has subtle navy left-border for brand identity, light grey
     border-radius for a soft card feel, and a faint shadow approximation
     via background tint on the header strip.
  */
  .hotel-card {
    margin-bottom: 18px;
    border-radius: 10px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--navy);
    overflow: hidden;
    /* Soft pagination: a card may split across pages if it's too tall to
       fit in the remaining space (strict page-break-inside: avoid causes
       huge whitespace gaps). The header-with-first-row guarantee comes
       from the hotel-card-header rule below. */
    page-break-inside: auto;
    orphans: 3;
    widows: 3;
  }
  .hotel-card:last-child { margin-bottom: 0; }

  /* Header strip — image on the left, metadata column on the right.
     Keep this together with the first table row so a card never
     orphans its header at the bottom of a page. */
  .hotel-card-header {
    display: flex;
    align-items: stretch;
    gap: 14px;
    padding: 14px;
    background: #fafbfa;
    page-break-after: avoid;
  }

  /* 160x120 postcard-sized hotel image. object-fit: cover crops to
     fill the box without distorting; soft border + radius matches
     the FE Add-Hotel card. */
  .hotel-thumb {
    width: 160px;
    height: 120px;
    object-fit: cover;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: #f5f5f5;
    flex-shrink: 0;
  }
  /* When a hotel has no image at all, render a clean grey placeholder
     rather than a broken-img icon. Same dimensions as a real thumb so
     the layout doesn't shift between image / no-image hotels. */
  .hotel-thumb-empty {
    width: 160px;
    height: 120px;
    border-radius: 8px;
    border: 1px dashed var(--border);
    background: #f5f5f5;
    flex-shrink: 0;
  }

  /* Metadata column — fills remaining width to the right of the image. */
  .hotel-card-meta {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0; /* allow long names to wrap */
    flex: 1;
  }
  /* Top row inside the metadata column: name + stars stack on the left,
     free-cancellation badge pushes to the right. Aligned to the top so
     long hotel names wrap downward without dragging the badge. */
  .hotel-card-name-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  .hotel-card-name-stack {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex: 1;
  }
  .hotel-name {
    color: var(--navy);
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.005em;
    text-decoration: none; /* no underline on the linked variant */
    line-height: 1.25;
  }
  .hotel-card-stars { line-height: 1; }
  .star-rating {
    color: var(--green);
    font-size: 14px;
    letter-spacing: 1px;
  }

  /* Free-cancellation badge — top-right of card header. Soft brand-tinted
     background, brand-green check, navy title, grey deadline sub-line.
     Sits at the same baseline as the hotel name. */
  .cxl-badge {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
    padding: 6px 10px;
    border-radius: 8px;
    background: var(--pill);
    border: 1px solid var(--green-light);
    flex-shrink: 0;
    max-width: 200px;
    text-align: right;
  }
  .cxl-badge-title {
    color: var(--navy);
    font-size: 11px;
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: 0.01em;
  }
  .cxl-badge-sub {
    color: var(--grey);
    font-size: 10px;
    line-height: 1.2;
  }

  /* Address line: pin emoji acts as a small icon glyph. Same grey
     tone as the FE Hotel Card location row. */
  .hotel-card-location {
    color: var(--grey);
    font-size: 12px;
    line-height: 1.4;
    display: flex;
    align-items: flex-start;
    gap: 4px;
  }
  .hotel-card-location .pin {
    font-size: 11px;
    opacity: 0.7;
    flex-shrink: 0;
    margin-top: 1px;
  }
  /* Short hotel description — sits between location and chips. Reserves
     ~3 lines of space so every card has a consistent description block
     height (12px font * 1.5 line-height = 18px per line → 3 lines ≈ 54px).
     Long descriptions clamp to 3 lines with a trailing ellipsis via
     -webkit-line-clamp. Short descriptions occupy the same 3-line slot,
     which keeps the chip row + pricing table aligned across cards.
     The JS-side clampDescription() caps at 220 chars as a backstop so
     Puppeteer never has to render a multi-KB string. */
  .hotel-card-desc {
    color: var(--navy);
    font-size: 12px;
    line-height: 1.5;
    opacity: 0.85;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    min-height: calc(12px * 1.5 * 3); /* 3 reserved lines */
  }
  .hotel-card-tags {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 2px;
  }
  /* Inline chip — meal plan + facilities. Soft brand-tinted background,
     navy text, pill-shaped. Stays compact even when wrapping. */
  .chip {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 999px;
    background: var(--pill);
    color: var(--navy);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1.4;
    border: 1px solid var(--green-light);
  }

  /* The pricing table inside a card. The base .tbl styling is already
     defined elsewhere — these rules only adjust how it sits inside the
     card chrome (no double border, full-bleed within the card). */
  .hotel-card-table {
    border-top: 1px solid var(--border);
    border-radius: 0; /* card itself owns the rounded corners */
    border-left: none;
    border-right: none;
    border-bottom: none;
  }

  /* Card footer — reservation reference moved here so it sits below the
     pricing summary, where staff/customer expects to find tracking IDs.
     Keeps the top-right of the card free for the free-cancellation badge. */
  .hotel-card-footer {
    display: flex;
    justify-content: flex-end;
    padding: 8px 16px;
    background: #fafbfa;
    border-top: 1px solid var(--border);
  }
  .hotel-card-footer .hotel-ref {
    color: var(--grey);
    font-size: 11px;
    white-space: nowrap;
  }
  .hotel-ref {
    color: var(--grey);
    font-size: 11px;
    flex-shrink: 0;
    white-space: nowrap;
  }

  /* ── Grand total bar (§6.6) ────────────────────────────────────────── */
  .grand {
    background: var(--green);
    padding: 20px 32px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border);
    page-break-inside: avoid;
  }
  .grand .lbl {
    color: var(--navy);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .grand .val {
    color: var(--navy);
    font-size: 22px;
    font-weight: 700;
  }

  /* ── Payment details (§6.7) ────────────────────────────────────────── */
  .pay-pill {
    background: var(--pill);
    border: 1px solid var(--green-light);
    border-radius: 4px;
    padding: 12px 16px;
    margin-bottom: 16px;
    color: var(--navy);
    font-size: 13px;
  }
  .pay-pill b { font-weight: 700; }
  .bank-tbl {
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 0;
    page-break-inside: avoid;
  }
  .bank-tbl .r {
    display: flex;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
  }
  .bank-tbl .r:last-child { border-bottom: none; }
  .bank-tbl .k {
    width: 180px;
    color: var(--grey);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .bank-tbl .v {
    flex: 1;
    color: var(--navy);
    font-size: 13px;
    font-weight: 600;
  }

  /* ── T&C / Cancellation rich-text (policies-rich-text-handover.md §4) ──
     Class name .policy-html matches the FE preview wrapper so the PDF
     and the on-screen preview share the same CSS contract. The handover
     warns: without padding-left + list-style-type, the renderer's
     defaults strip bullets/numbers — which was the original bug.
     ─────────────────────────────────────────────────────────────────── */
  .policy-html {
    font-family: 'Montserrat', sans-serif;
    font-size: 13px;
    font-weight: 400;
    line-height: 1.6;
    color: #686868;
  }

  /* Paragraph spacing — tight, brand-aligned. */
  .policy-html p { margin: 0 0 8px 0; }
  .policy-html p:last-child { margin-bottom: 0; }

  /* Inline emphasis — brand navy for bold/strong so it pops. */
  .policy-html b,
  .policy-html strong {
    font-weight: 700;
    color: #071C42;
  }
  .policy-html i,
  .policy-html em { font-style: italic; }
  .policy-html u { text-decoration: underline; }
  .policy-html strike,
  .policy-html s { text-decoration: line-through; }

  /* Lists — disc/decimal, indented 24 px, tight rhythm. */
  .policy-html ul {
    list-style-type: disc;
    padding-left: 24px;
    margin: 4px 0;
  }
  .policy-html ol {
    list-style-type: decimal;
    padding-left: 24px;
    margin: 4px 0;
  }
  .policy-html li { margin: 2px 0; }

  /* Nested lists — alternating markers, tighter spacing. */
  .policy-html ul ul,
  .policy-html ol ul {
    list-style-type: circle;
    margin: 0;
  }
  .policy-html ul ol,
  .policy-html ol ol {
    list-style-type: lower-alpha;
    margin: 0;
  }

  /* Links — green underline matches the brand accent. */
  .policy-html a {
    color: #AAC737;
    text-decoration: underline;
  }

  /* Inline images — fit within the column, never overflow. */
  .policy-html img {
    max-width: 100%;
    height: auto;
  }

  /* Alignment — the editor emits inline styles. Ensure they take effect
     inside the policy block (not overridden by parent typography rules). */
  .policy-html [style*="text-align: center"] { text-align: center; }
  .policy-html [style*="text-align: right"]  { text-align: right; }
  .policy-html [style*="text-align: justify"] { text-align: justify; }

  /* Pagination behaviour for long policies (§6.3):
     - never break the section heading away from its first paragraph
     - allow page breaks between paragraphs / list items so a long bullet
       can split across pages instead of being pushed to the next one */
  .section.terms h3,
  .section.cancellation h3 { page-break-after: avoid; }
  .section.terms h3 { margin-bottom: 14px; }
  .policy-html li { page-break-inside: auto; }

  /* ── Footer (§6.10) ────────────────────────────────────────────────── */
  .footer-divider {
    height: 2px;
    background: var(--green);
  }
  .doc-footer {
    background: var(--navy);
    padding: 20px 32px;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
  }
  /* Left column: SETT Groups logo above the legal blurb. Stacking
     the brand mark on top of the fine-print reads as "here's who
     this document is from, and here's the legal note" — the standard
     corporate-document footer pattern. */
  .doc-footer .footer-left {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    max-width: 520px;
  }
  /* SETT umbrella mark on the navy band. Brand-green letterforms read
     cleanly on navy without any CSS filter. 40px keeps the mark
     visible but smaller than the larger "24 H GROUP OFFER" mark in
     the header so the visual hierarchy stays right. */
  .doc-footer .footer-logo {
    height: 40px;
    width: auto;
    display: block;
  }
  .doc-footer .legal {
    color: rgba(255, 255, 255, 0.8);
    font-size: 10px;
    line-height: 1.5;
    margin: 0;
  }
  .doc-footer .issued .lbl {
    color: var(--green);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .doc-footer .issued .name {
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    margin-top: 2px;
  }
</style>
</head>
<body>
<div class="doc">

  <!-- ── Header (§6.1) ─────────────────────────────────────────────── -->
  <div class="doc-header">
    <img class="logo" src="${logoSrc}" alt="SETT" />
    <div class="meta">
      <div class="label">${escapeHtml(t.offer)}</div>
      <div class="docno">${escapeHtml(t.documentNo)} ${escapeHtml(documentCode)}</div>
      <div class="date">${escapeHtml(createdAt)}</div>
    </div>
  </div>
  <div class="accent-bar"></div>

  <!-- ── Supplier / Customer (§6.2) ───────────────────────────────── -->
  <div class="section grid-2">
    <div>
      <div class="label-sm">${escapeHtml(t.supplier)}</div>
      <div class="meta-name">${escapeHtml(SETT_SUPPLIER.companyName)}</div>
      ${metaRow(t.assignedPerson, SETT_SUPPLIER.assignedPerson)}
      ${metaRow(t.emailAddress, SETT_SUPPLIER.email)}
      ${metaRow(t.phoneNumber, SETT_SUPPLIER.phone)}
      ${metaRow(t.address, SETT_SUPPLIER.address)}
      ${metaRow(t.taxId, SETT_SUPPLIER.taxId)}
    </div>
    <div>
      <div class="label-sm">${escapeHtml(t.customer)}</div>
      <div class="meta-name">${escapeHtml(customerName)}</div>
      ${metaRow(t.emailAddress, data.contactEmail || '—')}
      ${metaRow(t.phoneNumber, customerPhone)}
    </div>
  </div>

  <!-- ── Trip Details (§6.3) ──────────────────────────────────────── -->
  <div class="section">
    <div class="label-sm">${escapeHtml(t.tripDetails)}</div>
    <div class="grid-3">
      ${metaRow(t.destination, data.destinationName || '—')}
      ${metaRow(
          t.checkinOut,
          `${formatDateEU(data.checkinDate)} — ${formatDateEU(data.checkoutDate)}`,
      )}
      ${metaRow(t.guests, data.groupSize != null ? String(data.groupSize) : '—')}
    </div>
  </div>

  <!-- ── Hotel Details (§6.4) ─────────────────────────────────────── -->
  ${hotelDetailsHtml}

  <!-- ── Service Details (§6.5) ───────────────────────────────────── -->
  ${serviceDetailsHtml}

  <!-- ── Grand Total (§6.6) ───────────────────────────────────────── -->
  <div class="grand">
    <span class="lbl">${escapeHtml(t.grandTotal)}</span>
    <span class="val">${symbol}${formatPriceEU(grandTotal)}</span>
  </div>

  <!-- ── Payment Details (§6.7) — Pay-by-card button DELETED per
       user decision 2026-06-02; pill + bank table remain. ───────── -->
  <div class="section">
    <h3>${escapeHtml(t.paymentDetails)}</h3>
    <div class="pay-pill">
      ${escapeHtml(t.payPrompt)} <b>${symbol}${formatPriceEU(grandTotal)}</b>
      ${escapeHtml(t.payBy)} <b>${escapeHtml(paymentDue)}</b>.
    </div>
    <div class="bank-tbl">
      <div class="r"><div class="k">${escapeHtml(t.bankName)}</div><div class="v">${escapeHtml(SETT_BANK.bankName)}</div></div>
      <div class="r"><div class="k">${escapeHtml(t.accountHolder)}</div><div class="v">${escapeHtml(SETT_BANK.accountHolder)}</div></div>
      <div class="r"><div class="k">${escapeHtml(t.iban)}</div><div class="v">${escapeHtml(SETT_BANK.iban)}</div></div>
      <div class="r"><div class="k">${escapeHtml(t.swiftBic)}</div><div class="v">${escapeHtml(SETT_BANK.swiftBic)}</div></div>
    </div>
  </div>

  <!-- ── Cancellation (§6.8 — from /settings/policies, conditional) ── -->
  ${cancellationHtml}

  <!-- ── Terms & Conditions (§6.9 — from /settings/policies, conditional)
       Hard-coded bullets removed per FE handover 2026-06-02. Block
       renders only when /settings/policies has a value for the
       requested language (or a fallback language). ───────────────── -->
  ${termsHtml}

  <!-- ── Footer (§6.10) ───────────────────────────────────────────── -->
  <!-- Rendered by Puppeteer's native displayHeaderFooter at the bottom
       of every page (see generateOfferPdf below + buildFooterTemplate).
       Pinning a footer to the bottom of the last page via CSS does NOT
       work under Chromium's print engine — it ignores flex pagination
       and the 'vh' unit resolves only to the per-page box, so the
       sticky-footer pattern falls apart. Native footer-template is the
       reliable workaround. -->

</div>
</body>
</html>`;
}

/**
 * Build the HTML passed to Puppeteer's `footerTemplate`. Rendered at the
 * bottom of EVERY page in the print viewport. Constraints from Puppeteer:
 *   - Inline styles only (no <link>, no <style> blocks honoured).
 *   - Images must be data URIs.
 *   - Font size has to be set explicitly — the default is tiny.
 *   - The template body must be wrapped in a root element to render
 *     (Puppeteer documents this).
 *
 * The visual mirrors the previous inline footer (navy band, green
 * divider, SETT logo + legal blurb on the left, "ISSUED BY <name>" on
 * the right) so existing PDFs look unchanged on page 1.
 */
function buildFooterTemplate(
    t: PdfTranslations,
    footerLogoDataUri: string,
): string {
    // The escape helpers from the outer module aren't in scope here
    // because the footer is rendered in Chrome's print-utility process
    // (a separate document). Inline-escape the strings we know come
    // from the dictionary; they're hand-written and don't carry HTML,
    // but we still escape defensively to avoid any breakage if a
    // future dictionary entry contains `<`/`&`.
    const esc = (s: string) =>
        String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    return `
<div style="
    width: 100%;
    font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
">
  <div style="height: 2px; background: #AAC737;"></div>
  <div style="
      background: #071C42;
      padding: 16px 32px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      box-sizing: border-box;
  ">
    <div style="
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
        max-width: 520px;
    ">
      <img src="${footerLogoDataUri}" alt="SETT Groups" style="height: 32px; width: auto; display: block;" />
      <p style="
          color: rgba(255, 255, 255, 0.8);
          font-size: 9px;
          line-height: 1.4;
          margin: 0;
      ">${esc(t.footerLegal)}</p>
    </div>
    <div>
      <div style="
          color: #AAC737;
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
      ">${esc(t.issuedBy)}</div>
      <div style="
          color: #fff;
          font-size: 12px;
          font-weight: 600;
          margin-top: 2px;
      ">${esc(ISSUED_BY)}</div>
    </div>
  </div>
</div>`;
}

// ─── Puppeteer renderer ──────────────────────────────────────────────────────

/**
 * Singleton browser instance — Puppeteer's launch cost is significant
 * (~500ms) so we keep one instance alive across renders. The renderer is
 * called from request handlers, so the same Node process serves many
 * requests; sharing a browser is safe and dramatically faster.
 *
 * The browser is closed on process exit via a SIGTERM handler so it gets
 * cleaned up during graceful shutdowns (PM2 reload, container stop).
 */
let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
    if (!browserPromise) {
        browserPromise = puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--font-render-hinting=none',
            ],
        });
        // Auto-recreate the browser if it ever crashes
        browserPromise
            .then((b) => {
                b.on('disconnected', () => {
                    logger.warn('Puppeteer browser disconnected — will relaunch on next render');
                    browserPromise = null;
                });
            })
            .catch((err) => {
                logger.error({ err }, 'Puppeteer initial launch failed');
                browserPromise = null;
            });
    }
    return browserPromise;
}

// Graceful shutdown
const closeOnExit = async () => {
    if (browserPromise) {
        try {
            const b = await browserPromise;
            await b.close();
        } catch {
            /* best effort */
        }
        browserPromise = null;
    }
};
process.once('SIGTERM', () => { void closeOnExit(); });
process.once('SIGINT',  () => { void closeOnExit(); });

/**
 * Render an Offer PDF.
 *
 * Public API unchanged from the previous (pdfkit) implementation — the
 * input shape `OfferPdfData` is identical so every existing caller keeps
 * working.
 */
export async function generateOfferPdf(data: OfferPdfData): Promise<Buffer> {
    const html = buildOfferHtml(data);
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        // Wait for fonts + images (logo data URI is inline so it's instant,
        // but Google Fonts (Montserrat) is referenced via CSS — give it a
        // network-idle window so the fonts load before snapshot.
        await page.setContent(html, { waitUntil: 'load' });
        // Give web fonts a moment to load even after `load` fires.
        await page.evaluateHandle('document.fonts.ready');
        // Render the navy footer band via Puppeteer's native footer slot,
        // pinned to the bottom of every page. CSS-based sticky footers
        // do NOT work under Chromium's print pagination — flex layout is
        // skipped during page-break computation and vh units resolve
        // only to the per-page box. The native slot sidesteps all of
        // that and renders reliably across single-page and multi-page
        // documents.
        //
        // bottom: '140px' reserves vertical room so body content doesn't
        // bleed under the footer band when content reaches the page
        // edge.
        //
        // Sizing math:
        //   - Green divider:               2px
        //   - Navy band padding (top+bot): 32px
        //   - Content inside (logo 32px + gap 8px + 2-line legal ~25px): ~65px
        //   → Total painted footer height: ~99px
        //
        // The previous value of 110px sometimes let the last content row
        // (e.g. "Reservation Ref: SETT-XXX-YYY") render UNDER the navy
        // band because Chromium's print engine paints the
        // `displayHeaderFooter` slot on top of any body that spills into
        // the reserved margin. 140px gives ~40px of safety gap between
        // the last body row and the top of the footer band.
        const t = getPdfTranslations(data.language === 'de' ? 'de' : 'en');
        const footerLogoSrc = getInlineFooterLogoDataUri();
        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: 0, right: 0, bottom: '140px', left: 0 },
            preferCSSPageSize: true,
            displayHeaderFooter: true,
            // Empty header (Puppeteer requires both templates when
            // displayHeaderFooter is true; otherwise it renders its
            // default date/page header).
            headerTemplate: '<span></span>',
            footerTemplate: buildFooterTemplate(t, footerLogoSrc),
        });
        return Buffer.from(pdf);
    } catch (err) {
        logger.error({ err }, 'Puppeteer PDF render failed');
        throw err;
    } finally {
        await page.close().catch(() => { /* best effort */ });
    }
}

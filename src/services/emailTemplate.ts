/**
 * SETT Hub — Branded Email Templates
 *
 * Based on SETT-Hub-Brand-Guidelines-v2:
 *   - Colors: Navy #071c42, Green #AAC737, Grey #686868, White #FFFFFF
 *   - Font: Montserrat (Google Fonts), fallback Arial/Helvetica
 *   - Logos: Group Offer logo for group emails, SVG logo for general
 *   - Tone: Professional, confident, not corporate-stiff
 *
 * Email Template Rules (from brand guidelines):
 *   - Inline CSS only (Gmail strips <style> blocks)
 *   - Table-based layout, max width 600px
 *   - No base64 images — use hosted URLs only
 *   - No CSS animations
 *   - CTA button: green #AAC737, navy text, 12px 28px padding, 4px radius
 */

// ─── Brand tokens ────────────────────────────────────────────────────────────

const SETT_NAVY = '#071c42';
const SETT_GREEN = '#AAC737';
const SETT_GREEN_DARK = '#7a9420';
const SETT_GREY = '#686868';
const SETT_LIGHT_BG = '#F8F9FA';
const SETT_WHITE = '#FFFFFF';
const SETT_BORDER = '#E0E0E0';

// ─── Logo URLs (hosted — no base64 per brand guidelines) ─────────────────────
// Server base URL for self-hosted assets (email logos served from /assets/)
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || 'http://localhost:4000';

// §4.4: SVG logo (hosted on tools.s-e-t-t.com — verified working)
const SVG_LOGO_URL = 'https://tools.s-e-t-t.com/ceo-dashboard/assets/setthub-logo.svg';
// §4.2: Group Offer logo — use self-hosted if SERVER_BASE_URL is set to a public domain,
// otherwise fall back to the SVG logo (which is verified working)
const GROUP_OFFER_LOGO_URL = SERVER_BASE_URL.includes('localhost')
    ? SVG_LOGO_URL
    : `${SERVER_BASE_URL}/assets/group-offer-header.png`;

/** Marketing site — used in the email FOOTER only (links to www.s-e-t-t.com home). */
const WEBSITE_URL = 'https://www.s-e-t-t.com';

/**
 * GroupHub dashboard base URL — used in CTA buttons inside emails.
 * Local dev: http://localhost:3000   |   Production: https://group-ai.s-e-t-t.com
 * Configurable via DASHBOARD_BASE_URL env var so the email links resolve to the
 * correct host across environments. Trailing slashes stripped.
 */
function dashboardBase(): string {
    const raw = process.env.DASHBOARD_BASE_URL || 'https://group-ai.s-e-t-t.com';
    return raw.replace(/\/+$/, '');
}

/** Build a deep link to the request detail page; falls back to the list when id missing. */
function requestLink(requestId?: string): string {
    return requestId
        ? `${dashboardBase()}/booking-requests/${requestId}`
        : `${dashboardBase()}/booking-requests`;
}

/** Build a deep link to the proposal detail page; falls back to the list when id missing. */
function proposalLink(proposalId?: string): string {
    return proposalId
        ? `${dashboardBase()}/proposals/${proposalId}`
        : `${dashboardBase()}/booking-requests`;
}

// ─── Font stack ──────────────────────────────────────────────────────────────
const FONT_STACK = "'Montserrat',Arial,Helvetica,sans-serif";

// ─── Shared layout wrapper ───────────────────────────────────────────────────

type EmailType = 'group' | 'general';

function emailLayout(opts: {
    preheader?: string;
    body: string;
    footerExtra?: string;
    type?: EmailType;
}): string {
    const emailType = opts.type ?? 'general';
    const logoUrl = emailType === 'group' ? GROUP_OFFER_LOGO_URL : SVG_LOGO_URL;
    const logoWidth = emailType === 'group' ? 280 : 180;
    const logoAlt = emailType === 'group'
        ? 'SETT Hub — 24H Group Offer — Worldwide Group Offers'
        : 'SETT Hub — Sport &amp; Events Tours &amp; Travel';

    return `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>SETT Hub</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
  <!--[if mso]>
  <style>* { font-family: Arial, Helvetica, sans-serif !important; }</style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:${SETT_LIGHT_BG};font-family:${FONT_STACK};-webkit-font-smoothing:antialiased;">
  ${opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${SETT_LIGHT_BG};">${opts.preheader}</div>` : ''}

  <!-- Outer wrapper -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${SETT_LIGHT_BG};">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <!-- Inner card — 600px max -->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:${SETT_WHITE};border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">

          <!-- Header bar — Navy background with logo -->
          <tr>
            <td style="background-color:${SETT_NAVY};padding:28px 32px;text-align:center;">
              <a href="${WEBSITE_URL}" target="_blank" style="text-decoration:none;">
                <img src="${logoUrl}" alt="${logoAlt}" width="${logoWidth}" style="display:inline-block;max-width:${logoWidth}px;height:auto;" />
              </a>
            </td>
          </tr>

          <!-- Green accent line (2-3px per brand guidelines §6.1) -->
          <tr>
            <td style="background-color:${SETT_GREEN};height:3px;font-size:0;line-height:0;">&nbsp;</td>
          </tr>

          <!-- Body content -->
          <tr>
            <td style="padding:32px 32px 24px 32px;color:${SETT_NAVY};font-size:15px;line-height:1.6;">
              ${opts.body}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:0 32px 24px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-top:1px solid ${SETT_BORDER};padding-top:20px;">
                    ${opts.footerExtra ?? ''}
                    <p style="margin:8px 0 0 0;font-size:11px;color:${SETT_GREY};line-height:1.5;font-family:${FONT_STACK};">
                      S-E-T-T Worldwide Reservation FZE &middot; Room 1901, Sheikh Hammad Bin Abdullah St, P.O. Box 4422, Fujairah, UAE<br/>
                      <a href="${WEBSITE_URL}" style="color:${SETT_GREEN_DARK};text-decoration:none;">www.s-e-t-t.com</a> &middot;
                      <a href="mailto:reservation@s-e-t-t.com" style="color:${SETT_GREEN_DARK};text-decoration:none;">reservation@s-e-t-t.com</a> &middot;
                      +43 699 1016 3854
                    </p>
                    <p style="margin:12px 0 0 0;font-size:10px;color:#999;line-height:1.4;font-family:${FONT_STACK};">
                      &copy; ${new Date().getFullYear()} S-E-T-T Worldwide Reservation FZE. All rights reserved.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Green bottom bar (per §6.1 footer) -->
          <tr>
            <td style="background-color:${SETT_GREEN};height:4px;font-size:0;line-height:0;">&nbsp;</td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

// ─── Reusable components ─────────────────────────────────────────────────────

/** Page Title — weight 800, 22-28px, navy */
function heading(text: string): string {
    return `<h1 style="margin:0 0 16px 0;font-family:${FONT_STACK};font-size:24px;font-weight:800;color:${SETT_NAVY};letter-spacing:-0.02em;">${text}</h1>`;
}

/** Section Title — weight 800, 18px, navy */
function subheading(text: string): string {
    return `<h2 style="margin:24px 0 12px 0;font-family:${FONT_STACK};font-size:18px;font-weight:800;color:${SETT_NAVY};">${text}</h2>`;
}

/** Body Text — weight 400, 14-16px, grey #686868 */
function paragraph(text: string): string {
    return `<p style="margin:0 0 14px 0;font-family:${FONT_STACK};font-size:15px;color:${SETT_GREY};line-height:1.6;">${text}</p>`;
}

/** Detail row — label: 600, UPPERCASE, 12px, letter-spacing 0.05em (per §3 Labels/Tags) */
function detailRow(label: string, value: string): string {
    return `
    <tr>
      <td style="padding:10px 14px;font-family:${FONT_STACK};font-size:12px;font-weight:600;color:${SETT_NAVY};text-transform:uppercase;letter-spacing:0.1em;border-bottom:1px solid ${SETT_BORDER};width:40%;vertical-align:top;">${label}</td>
      <td style="padding:10px 14px;font-family:${FONT_STACK};font-size:14px;font-weight:400;color:${SETT_GREY};border-bottom:1px solid ${SETT_BORDER};vertical-align:top;">${value}</td>
    </tr>`;
}

/** Details table — border 1px ${SETT_BORDER}, radius 6px */
function detailsTable(rows: Array<{ label: string; value: string }>): string {
    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid ${SETT_BORDER};border-radius:6px;overflow:hidden;">
      <tbody>
        ${rows.map((r) => detailRow(r.label, r.value)).join('')}
      </tbody>
    </table>`;
}

/** CTA Button — green #AAC737, navy text, 12px 28px padding, 4px radius (per brand guidelines §5.1) */
function ctaButton(text: string, url: string): string {
    return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        <td style="background-color:${SETT_GREEN};border-radius:4px;">
          <a href="${url}" target="_blank" style="display:inline-block;padding:12px 28px;font-family:${FONT_STACK};font-size:14px;font-weight:700;color:${SETT_NAVY};text-decoration:none;text-transform:uppercase;letter-spacing:0.08em;">${text}</a>
        </td>
      </tr>
    </table>`;
}

/** Alert/info box — left border accent */
function alertBox(text: string, type: 'warning' | 'info' | 'success' = 'info'): string {
    const colors = {
        warning: { bg: '#FFF8E1', border: '#FFB300', icon: '&#9888;' },
        info: { bg: '#E8F0FE', border: SETT_NAVY, icon: '&#8505;' },
        success: { bg: '#E8F5E9', border: SETT_GREEN, icon: '&#10003;' },
    };
    const c = colors[type];
    return `
    <div style="margin:16px 0;padding:14px 18px;background-color:${c.bg};border-left:4px solid ${c.border};border-radius:4px;font-family:${FONT_STACK};font-size:14px;color:${SETT_NAVY};line-height:1.5;">
      <span style="font-size:16px;margin-right:6px;">${c.icon}</span> ${text}
    </div>`;
}

/** Shortfall/metrics table — navy header row, white body rows */
function shortfallTable(rows: Array<{ label: string; value: string | number }>): string {
    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border-collapse:collapse;">
      ${rows.map((r, i) => `
      <tr>
        <td style="padding:10px 14px;font-family:${FONT_STACK};font-size:${i === 0 ? '12' : '13'}px;font-weight:${i === 0 ? '700' : '600'};color:${i === 0 ? SETT_WHITE : SETT_GREY};background-color:${i === 0 ? SETT_NAVY : 'transparent'};${i > 0 ? `border-bottom:1px solid ${SETT_BORDER};` : ''}${i === 0 ? 'text-transform:uppercase;letter-spacing:0.1em;' : ''}">${r.label}</td>
        <td style="padding:10px 14px;font-family:${FONT_STACK};font-size:${i === 0 ? '12' : '14'}px;font-weight:${i === 0 ? '700' : '400'};text-align:right;color:${i === 0 ? SETT_WHITE : SETT_NAVY};background-color:${i === 0 ? SETT_NAVY : 'transparent'};${i > 0 ? `border-bottom:1px solid ${SETT_BORDER};` : ''}${i === 0 ? 'text-transform:uppercase;letter-spacing:0.1em;' : ''}">${r.value}</td>
      </tr>`).join('')}
    </table>`;
}

// ─── Email builders ──────────────────────────────────────────────────────────

/**
 * Staff notification: new AI-generated group offer ready for review.
 * Uses GROUP OFFER logo (§4.5: "Email header (group offers) → Group-offer--big-2.png")
 */
export function buildOfferReadyEmail(opts: {
    referenceNumber: number;
    contactName: string;
    destinationName: string;
    requestId?: string;
}): string {
    const url = requestLink(opts.requestId);
    return emailLayout({
        type: 'group',
        preheader: `New group offer #${opts.referenceNumber} for ${opts.destinationName} is ready for review`,
        body: `
            ${heading('New Group Offer Ready')}
            ${paragraph(`A new AI-generated group offer has been prepared and is waiting for your review.`)}
            ${detailsTable([
                { label: 'Reference', value: `<strong style="color:${SETT_NAVY};">#${opts.referenceNumber}</strong>` },
                { label: 'Client', value: opts.contactName },
                { label: 'Destination', value: opts.destinationName },
            ])}
            ${alertBox('This offer was generated automatically. Please review the hotel selection and pricing before approving.', 'info')}
            ${ctaButton('Review Offer', url)}
            ${paragraph('Log in to the SETT Hub dashboard to review, adjust, and approve the offer.')}
        `,
    });
}

/**
 * Staff notification: insufficient inventory — partial offer saved.
 * Uses GROUP OFFER logo.
 */
export function buildInsufficientInventoryEmail(opts: {
    referenceNumber: number;
    contactName: string;
    destinationName: string;
    roomsNeeded: number;
    roomsFound: number;
    roomsMissing: number;
    hotelsAccepted: number;
    suggestion: string;
    requestId?: string;
}): string {
    const dashboardUrl = requestLink(opts.requestId);
    const coveragePct = opts.roomsNeeded > 0 ? Math.round((opts.roomsFound / opts.roomsNeeded) * 100) : 0;
    return emailLayout({
        type: 'group',
        preheader: `Offer #${opts.referenceNumber}: ${opts.roomsMissing} rooms short — manual action required`,
        body: `
            ${heading('Insufficient Inventory')}
            ${alertBox('The AI pipeline could not fully satisfy this group request. A partial offer has been saved — manual intervention is required.', 'warning')}
            ${detailsTable([
                { label: 'Reference', value: `<strong style="color:${SETT_NAVY};">#${opts.referenceNumber}</strong>` },
                { label: 'Client', value: opts.contactName },
                { label: 'Destination', value: opts.destinationName },
            ])}
            ${subheading('Shortfall Details')}
            ${shortfallTable([
                { label: 'Metric', value: 'Rooms' },
                { label: 'Rooms Needed', value: opts.roomsNeeded },
                { label: 'Rooms Found', value: opts.roomsFound },
                { label: 'Rooms Missing', value: `<span style="color:#CC3333;font-weight:700;">${opts.roomsMissing}</span>` },
                { label: 'Hotels Accepted', value: opts.hotelsAccepted },
                { label: 'Coverage', value: `${coveragePct}%` },
            ])}
            ${subheading('Suggested Action')}
            ${paragraph(opts.suggestion)}
            ${ctaButton('Complete Offer Manually', dashboardUrl)}
            ${paragraph('A partial offer has been saved with the hotels found so far. Please review and complete it in the dashboard.')}
        `,
    });
}

/**
 * Staff notification: offer declined by admin.
 * Uses GENERAL logo (not group-specific context).
 */
export function buildOfferDeclinedEmail(opts: {
    referenceNumber: number;
    contactName: string;
    destinationName: string;
    rejectionReason: string;
    proposalId?: string;
}): string {
    const dashboardUrl = proposalLink(opts.proposalId);
    return emailLayout({
        type: 'general',
        preheader: `Offer #${opts.referenceNumber} declined — action required`,
        body: `
            ${heading('Offer Declined')}
            ${alertBox('This offer has been declined by an admin and requires manual attention.', 'warning')}
            ${detailsTable([
                { label: 'Reference', value: `<strong style="color:${SETT_NAVY};">#${opts.referenceNumber}</strong>` },
                { label: 'Client', value: opts.contactName },
                { label: 'Destination', value: opts.destinationName },
            ])}
            ${subheading('Rejection Reason')}
            ${paragraph(opts.rejectionReason)}
            ${ctaButton('Review & Revise', dashboardUrl)}
            ${paragraph('Please create a revised offer in the dashboard.')}
        `,
    });
}

/**
 * Client-facing: offer PDF email sent to agent.
 * Uses GROUP OFFER logo (§4.5: "AI-generated group offers").
 * IMPORTANT: This is a client-facing email — use branded HTML template.
 */
export function buildOfferPdfEmail(opts: {
    referenceNumber: number;
    contactName: string;
    destinationName: string;
}): string {
    return emailLayout({
        type: 'group',
        preheader: `Your group accommodation offer #${opts.referenceNumber} for ${opts.destinationName} is ready`,
        body: `
            ${heading('Your Group Offer is Ready')}
            ${paragraph(`Dear ${opts.contactName},`)}
            ${paragraph(`Thank you for your enquiry. Please find attached your group accommodation offer for <strong>${opts.destinationName}</strong>.`)}
            ${detailsTable([
                { label: 'Reference', value: `<strong style="color:${SETT_NAVY};">#${opts.referenceNumber}</strong>` },
                { label: 'Destination', value: opts.destinationName },
            ])}
            ${alertBox('This is currently <strong>not a confirmed reservation</strong>. Hotel availability is limited and subject to change.', 'warning')}
            ${paragraph('To confirm your booking or for any questions, please contact us directly.')}
            ${ctaButton('Contact Us', `mailto:reservation@s-e-t-t.com?subject=Offer%20%23${opts.referenceNumber}`)}
            ${paragraph('We look forward to assisting you with your group travel arrangements.')}
            <p style="margin:24px 0 0 0;font-family:${FONT_STACK};font-size:15px;color:${SETT_NAVY};line-height:1.6;">
              Best regards,<br/>
              <strong>SETT Hub Group Bookings Team</strong><br/>
              <span style="font-size:13px;color:${SETT_GREY};">Sport &amp; Events Tours &amp; Travel</span>
            </p>
        `,
    });
}

/**
 * Staff notification: offer generation pipeline failed.
 * Uses GENERAL logo (system notification, not group-specific).
 */
export function buildOfferGenerationFailedEmail(opts: {
    referenceNumber: number;
    reason: string;
    requestId?: string;
}): string {
    const dashboardUrl = requestLink(opts.requestId);
    return emailLayout({
        type: 'general',
        preheader: `Offer #${opts.referenceNumber} generation failed — manual action required`,
        body: `
            ${heading('Offer Generation Failed')}
            ${alertBox('The automated offer generation pipeline encountered an issue and could not complete.', 'warning')}
            ${detailsTable([
                { label: 'Reference', value: `<strong style="color:${SETT_NAVY};">#${opts.referenceNumber}</strong>` },
                { label: 'Reason', value: opts.reason },
            ])}
            ${ctaButton('Handle Manually', dashboardUrl)}
            ${paragraph('Please log in to the dashboard to create the offer manually.')}
        `,
    });
}

// ─── Phase 1 templates (Brevo SMTP rollout) ──────────────────────────────────
// All include the brand promise: "Quote within 24 hours".

/** Reusable promise line used at the bottom of every Phase 1 email body. */
function quotePromise(): string {
    return `<p style="margin:18px 0 0 0;font-family:${FONT_STACK};font-size:13px;font-weight:600;color:${SETT_NAVY};">Quote within 24 hours.</p>`;
}

/**
 * Staff notification: a new booking request was just received.
 * Uses GROUP OFFER logo since this is the start of a group-offer workflow.
 */
export function buildNewRequestStaffEmail(opts: {
    referenceNumber: number;
    contactName: string;
    destinationName: string;
    source: string;
    requestId?: string;
    groupType?: string | null;
    averageAge?: number | null;
}): string {
    const dashboardUrl = requestLink(opts.requestId);
    const groupLine = formatGroupLine(opts.groupType, opts.averageAge);
    const baseRows = [
        { label: 'Reference', value: `<strong style="color:${SETT_NAVY};">#${opts.referenceNumber}</strong>` },
        { label: 'Client', value: opts.contactName },
        { label: 'Destination', value: opts.destinationName },
        { label: 'Source', value: opts.source },
    ];
    const rows = groupLine ? [...baseRows, { label: 'Group', value: groupLine }] : baseRows;
    return emailLayout({
        type: 'group',
        preheader: `New group request #${opts.referenceNumber} from ${opts.contactName} — ${opts.destinationName}`,
        body: `
            ${heading('New Group Request')}
            ${paragraph(`A new group request has been received via <strong>${opts.source}</strong> and is ready to be processed.`)}
            ${detailsTable(rows)}
            ${ctaButton('Open Request', dashboardUrl)}
            ${quotePromise()}
        `,
    });
}

/**
 * Format the "Group" line for staff-facing emails. Returns null when no
 * groupType is set so the row is omitted entirely (avoids "Group: —" noise
 * on legacy requests that pre-date the group_type field).
 *
 * For youth and school groups with a known average age, appends "(avg
 * age: N)" so staff sees the age before opening the request.
 */
function formatGroupLine(
    groupType: string | null | undefined,
    averageAge: number | null | undefined,
): string | null {
    if (!groupType) return null;
    const label = GROUP_TYPE_LABELS[groupType] ?? capitalise(groupType);
    if ((groupType === 'youth' || groupType === 'school') && typeof averageAge === 'number') {
        return `${label} (avg age: ${averageAge})`;
    }
    return label;
}

/**
 * English fallback labels for the staff email. The frontend owns full i18n;
 * we keep a tight English-only map here so the staff sees a clean label
 * regardless of where the request came from.
 */
const GROUP_TYPE_LABELS: Record<string, string> = {
    business:   'Business Group',
    leisure:    'Leisure Group',
    sports:     'Sports Group',
    youth:      'Youth Group',
    school:     'School Group',
    family:     'Family Group',
    wedding:    'Wedding Group',
    mice:       'MICE Group',
    conference: 'MICE Group', // legacy value — display as MICE
    other:      'Other',
};

function capitalise(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Customer-facing: confirmation that we received the enquiry.
 * Uses GROUP OFFER logo. Customer-facing tone, no internal links.
 */
export function buildNewRequestContactEmail(opts: {
    referenceNumber: number;
    contactName: string;
    destinationName: string;
}): string {
    return emailLayout({
        type: 'group',
        preheader: `We've received your enquiry for ${opts.destinationName} — Reference #${opts.referenceNumber}`,
        body: `
            ${heading('We have received your enquiry')}
            ${paragraph(`Dear ${opts.contactName},`)}
            ${paragraph(`Thank you for choosing SETT Groups. We have received your group accommodation request for <strong>${opts.destinationName}</strong>.`)}
            ${detailsTable([
                { label: 'Reference', value: `<strong style="color:${SETT_NAVY};">#${opts.referenceNumber}</strong>` },
                { label: 'Destination', value: opts.destinationName },
            ])}
            ${paragraph('Our team is preparing your offer. You will receive a detailed quote shortly.')}
            ${quotePromise()}
            <p style="margin:18px 0 0 0;font-family:${FONT_STACK};font-size:14px;color:${SETT_GREY};line-height:1.6;">
              For any questions, please reply to this email.
            </p>
            <p style="margin:24px 0 0 0;font-family:${FONT_STACK};font-size:15px;color:${SETT_NAVY};line-height:1.6;">
              Best regards,<br/>
              <strong>SETT Groups</strong>
            </p>
        `,
    });
}

/**
 * Staff notification: a proposal was approved.
 * Phase 1 reverses the previous "in-app only" rule — staff now receive an email too.
 */
export function buildOfferApprovedEmail(opts: {
    referenceNumber: number;
    contactName: string;
    destinationName: string;
    approvedBy: string;
    proposalId?: string;
}): string {
    const dashboardUrl = proposalLink(opts.proposalId);
    return emailLayout({
        type: 'group',
        preheader: `Offer #${opts.referenceNumber} approved`,
        body: `
            ${heading('Offer Approved')}
            ${alertBox('This offer has been approved and is ready to be sent to the contact.', 'success')}
            ${detailsTable([
                { label: 'Reference', value: `<strong style="color:${SETT_NAVY};">#${opts.referenceNumber}</strong>` },
                { label: 'Client', value: opts.contactName },
                { label: 'Destination', value: opts.destinationName },
                { label: 'Approved by', value: opts.approvedBy },
            ])}
            ${ctaButton('Open Offer', dashboardUrl)}
            ${quotePromise()}
        `,
    });
}

/**
 * Customer-facing: notification that a proposal was declined.
 * Counterpart to the staff-side buildOfferDeclinedEmail. Tone is courteous and brief.
 */
export function buildOfferDeclinedContactEmail(opts: {
    referenceNumber: number;
    contactName: string;
    destinationName: string;
    rejectionReason: string;
}): string {
    return emailLayout({
        type: 'group',
        preheader: `Update on your group offer #${opts.referenceNumber}`,
        body: `
            ${heading('Update on your group offer')}
            ${paragraph(`Dear ${opts.contactName},`)}
            ${paragraph(`We are writing regarding your group accommodation enquiry for <strong>${opts.destinationName}</strong>.`)}
            ${detailsTable([
                { label: 'Reference', value: `<strong style="color:${SETT_NAVY};">#${opts.referenceNumber}</strong>` },
                { label: 'Destination', value: opts.destinationName },
            ])}
            ${paragraph(`Unfortunately, we are not able to proceed with this offer at this time. Reason: ${opts.rejectionReason}`)}
            ${paragraph('Please feel free to reply to this email if you would like to discuss alternatives or submit a new enquiry.')}
            ${quotePromise()}
            <p style="margin:24px 0 0 0;font-family:${FONT_STACK};font-size:15px;color:${SETT_NAVY};line-height:1.6;">
              Best regards,<br/>
              <strong>SETT Groups</strong>
            </p>
        `,
    });
}

/**
 * Staff notification: booking request status transitioned to a tracked state.
 * Used for sent / completed / cancelled (configured via NOTIFY_STATUS_TRANSITIONS env var).
 */
export function buildStatusChangeEmail(opts: {
    referenceNumber: number;
    contactName: string;
    destinationName: string;
    fromStatus: string;
    toStatus: string;
    requestId?: string;
}): string {
    const dashboardUrl = requestLink(opts.requestId);
    return emailLayout({
        type: 'general',
        preheader: `Request #${opts.referenceNumber} status: ${opts.fromStatus} → ${opts.toStatus}`,
        body: `
            ${heading('Request Status Updated')}
            ${detailsTable([
                { label: 'Reference', value: `<strong style="color:${SETT_NAVY};">#${opts.referenceNumber}</strong>` },
                { label: 'Client', value: opts.contactName },
                { label: 'Destination', value: opts.destinationName },
                { label: 'Previous status', value: opts.fromStatus },
                { label: 'New status', value: `<strong style="color:${SETT_NAVY};">${opts.toStatus}</strong>` },
            ])}
            ${ctaButton('Open Request', dashboardUrl)}
            ${quotePromise()}
        `,
    });
}

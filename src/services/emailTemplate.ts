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
const SETT_GREEN_LIGHT = '#c8e050';
const SETT_GREY = '#686868';
const SETT_BLACK = '#0a0a0a';
const SETT_LIGHT_BG = '#F8F9FA';
const SETT_WHITE = '#FFFFFF';
const SETT_BORDER = '#E0E0E0';

// ─── Logo URLs (hosted — no base64 per brand guidelines) ─────────────────────
// §4.4: SVG logo for general email headers
const SVG_LOGO_URL = 'https://tools.s-e-t-t.com/ceo-dashboard/assets/setthub-logo.svg';
// §4.2: Group Offer logo for group-specific email headers
const GROUP_OFFER_LOGO_URL = 'https://tools.s-e-t-t.com/ceo-dashboard/assets/Group-offer--big-2.png';

const WEBSITE_URL = 'https://www.s-e-t-t.com';

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
    dashboardUrl?: string;
}): string {
    const dashboardUrl = opts.dashboardUrl ?? `${WEBSITE_URL}/dashboard`;
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
            ${ctaButton('Review Offer', dashboardUrl)}
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
    dashboardUrl?: string;
}): string {
    const dashboardUrl = opts.dashboardUrl ?? `${WEBSITE_URL}/dashboard`;
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
    dashboardUrl?: string;
}): string {
    const dashboardUrl = opts.dashboardUrl ?? `${WEBSITE_URL}/dashboard`;
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
    dashboardUrl?: string;
}): string {
    const dashboardUrl = opts.dashboardUrl ?? `${WEBSITE_URL}/dashboard`;
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

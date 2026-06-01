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

// ─── Logo URLs ────────────────────────────────────────────────────────────────
// Server base URL for self-hosted assets (email logos served from /assets/).
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || 'http://localhost:4000';
const IS_LOCALHOST = SERVER_BASE_URL.includes('localhost');

// §4.4: SVG logo (hosted on tools.s-e-t-t.com — verified working)
const SVG_LOGO_URL = 'https://tools.s-e-t-t.com/ceo-dashboard/assets/setthub-logo.svg';

/**
 * Stable Content-ID slugs we reference from the email HTML via `cid:` URLs.
 * The matching PNG bytes are attached to the outbound email by
 * `getInlineLogoAttachments()` below, which the notification-service
 * spreads onto the nodemailer `attachments` array. All mail clients
 * (Gmail, Outlook, Yopmail) render `cid:` references reliably because
 * the image bytes ship inside the email itself — no public URL needed.
 */
const LOGO_CID_GROUPS = 'sett-groups-logo';
const LOGO_CID_UMBRELLA = 'sett-umbrella-logo';

/** Resolve a `public/assets/<filename>` path across the few cwd shapes the app boots from. */
function resolveAsset(filename: string): string | null {
    try {
        const path = require('path') as typeof import('path');
        const fs = require('fs') as typeof import('fs');
        const candidates = [
            path.resolve(process.cwd(), 'public', 'assets', filename),
            path.resolve(__dirname, '..', '..', 'public', 'assets', filename),
            path.resolve(__dirname, '..', '..', '..', 'public', 'assets', filename),
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Return the inline-image attachments the email layout's `<img src="cid:…">`
 * tags reference. The notification service spreads these into the
 * nodemailer `attachments` array on every outbound email, so the logos
 * always travel with the message and render in any client.
 *
 * Returns `[]` (no attachments) if the PNGs are missing — the alt text on
 * the <img> tags is descriptive enough to keep the email readable.
 */
export function getInlineLogoAttachments(): Array<{
    filename: string;
    content: Buffer;
    contentType: string;
    cid: string;
}> {
    const fs = require('fs') as typeof import('fs');
    const out: Array<{ filename: string; content: Buffer; contentType: string; cid: string }> = [];

    const groupsPath = resolveAsset('s-e-t-t-groups-logo.png');
    if (groupsPath) {
        out.push({
            filename: 's-e-t-t-groups-logo.png',
            content: fs.readFileSync(groupsPath),
            contentType: 'image/png',
            cid: LOGO_CID_GROUPS,
        });
    }
    const umbrellaPath = resolveAsset('sett-umbrella-logo.png');
    if (umbrellaPath) {
        out.push({
            filename: 'sett-umbrella-logo.png',
            content: fs.readFileSync(umbrellaPath),
            contentType: 'image/png',
            cid: LOGO_CID_UMBRELLA,
        });
    }
    return out;
}

// §4.2: SETT Groups logo — header of group-context emails. The
// client-provided tile-grid "S-E-T-T Groups" mark, 600×300 PNG.
// In production we reference the hosted URL; on localhost we reference
// the CID-attached version (see getInlineLogoAttachments) so emails sent
// to external intercept inboxes still render the logo correctly.
const GROUP_OFFER_LOGO_URL = IS_LOCALHOST
    ? `cid:${LOGO_CID_GROUPS}`
    : `${SERVER_BASE_URL}/assets/s-e-t-t-groups-logo.png`;
// Umbrella SETT logo — always in the footer per Oliver's directive.
const UMBRELLA_LOGO_URL = IS_LOCALHOST
    ? `cid:${LOGO_CID_UMBRELLA}`
    : `${SERVER_BASE_URL}/assets/sett-umbrella-logo.png`;

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
    // Header logo:
    //  - group    → tile-grid "S-E-T-T Groups" mark (matches Oliver's
    //               2026-06-01 reference image).
    //  - general  → plain SETT Hub SVG mark for system/internal mails.
    const headerLogoUrl   = emailType === 'group' ? GROUP_OFFER_LOGO_URL : SVG_LOGO_URL;
    // SETT Groups logo is 2:1 (600×300); 180 px wide → 90 px tall at email
    // scale, matching the proportions in Oliver's reference image.
    const headerLogoWidth = emailType === 'group' ? 180 : 160;
    const headerLogoAlt   = emailType === 'group'
        ? 'SETT Groups'
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

  <!-- Outer wrapper — light grey page background -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${SETT_LIGHT_BG};">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <!-- Inner card — 600px max, white surface with subtle shadow -->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:${SETT_WHITE};border-radius:4px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">

          <!-- Top thin green bar -->
          <tr>
            <td style="background-color:${SETT_GREEN};height:4px;font-size:0;line-height:0;">&nbsp;</td>
          </tr>

          <!-- Header — WHITE background with logo centered (matches reference) -->
          <tr>
            <td style="background-color:${SETT_WHITE};padding:32px 32px 24px 32px;text-align:center;">
              <a href="${WEBSITE_URL}" target="_blank" style="text-decoration:none;">
                <img src="${headerLogoUrl}" alt="${headerLogoAlt}" width="${headerLogoWidth}" style="display:inline-block;max-width:${headerLogoWidth}px;height:auto;" />
              </a>
            </td>
          </tr>

          <!-- Green + navy double-stripe divider under header.
               Green ABOVE navy per Oliver's 2026-06-01 feedback.
               Both 3 px so they read clearly without eye strain. -->
          <tr>
            <td style="background-color:${SETT_GREEN};height:3px;font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="background-color:${SETT_NAVY};height:3px;font-size:0;line-height:0;">&nbsp;</td>
          </tr>

          <!-- Body content -->
          <tr>
            <td style="padding:32px 36px 28px 36px;color:${SETT_NAVY};font-size:15px;line-height:1.6;">
              ${opts.body}
            </td>
          </tr>

          <!-- Pre-footer divider — green ABOVE navy to mirror the
               header stripe (Oliver's 2026-06-01 feedback). Both 3 px. -->
          <tr>
            <td style="background-color:${SETT_GREEN};height:3px;font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="background-color:${SETT_NAVY};height:3px;font-size:0;line-height:0;">&nbsp;</td>
          </tr>

          <!-- Footer — umbrella logo ALWAYS appears here per Oliver's
               2026-06-01 feedback, regardless of email type. LTD entity
               address per reference image (Toronto, not the FZE UAE
               address that was previously used). -->
          <tr>
            <td style="background-color:${SETT_WHITE};padding:28px 36px 24px 36px;text-align:center;">
              ${opts.footerExtra ?? ''}
              <a href="${WEBSITE_URL}" target="_blank" style="text-decoration:none;display:inline-block;">
                <img src="${UMBRELLA_LOGO_URL}" alt="SETT — Sport &amp; Events Tours &amp; Travel" width="160" style="display:inline-block;max-width:160px;height:auto;margin-bottom:14px;" />
              </a>
              <p style="margin:8px 0 0 0;font-size:11px;color:${SETT_GREY};line-height:1.6;font-family:${FONT_STACK};text-align:center;">
                S-E-T-T Worldwide Reservation LTD<br/>
                2967 Dundas Street West, Unit 176d<br/>
                Toronto, ON M6P 1Z2, Canada
              </p>
              <p style="margin:12px 0 0 0;font-size:11px;color:${SETT_GREY};line-height:1.5;font-family:${FONT_STACK};text-align:center;">
                <a href="${WEBSITE_URL}" style="color:${SETT_GREEN_DARK};text-decoration:none;font-weight:600;">www.s-e-t-t.com</a> &middot;
                <a href="mailto:groups@s-e-t-t.com" style="color:${SETT_GREEN_DARK};text-decoration:none;font-weight:600;">groups@s-e-t-t.com</a>
              </p>
              <p style="margin:6px 0 0 0;font-size:11px;color:${SETT_GREY};line-height:1.5;font-family:${FONT_STACK};text-align:center;">
                AT +43 720 022 700 &middot; DE +49 8131 385 397 &middot; DK +45 32 330 082
              </p>
              <p style="margin:14px 0 0 0;font-size:10px;color:#999;line-height:1.4;font-family:${FONT_STACK};text-align:center;">
                &copy; ${new Date().getFullYear()} S-E-T-T Worldwide Reservation LTD. All rights reserved.
              </p>
            </td>
          </tr>

          <!-- Green bottom bar -->
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

/**
 * Body Text — weight 500 (slightly bold), 15 px, dark grey #4A4A4A.
 * Per Oliver's 2026-06-01 feedback: the body copy should read with a
 * touch more presence than a default 400-weight grey — without going so
 * dark it competes with the navy headings.
 */
function paragraph(text: string): string {
    return `<p style="margin:0 0 14px 0;font-family:${FONT_STACK};font-size:15px;font-weight:500;color:#4A4A4A;line-height:1.6;">${text}</p>`;
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

/**
 * Subtitle — uppercase grey line directly under the heading.
 * Matches the reference image's "GROUP ACCOMMODATION REQUEST · VIENNA, AUSTRIA"
 * line that sits between the H1 and the greeting.
 */
function subtitle(text: string): string {
    return `<p style="margin:-8px 0 22px 0;font-family:${FONT_STACK};font-size:12px;font-weight:600;color:${SETT_GREY};text-transform:uppercase;letter-spacing:0.1em;">${text}</p>`;
}

/**
 * Details card — light grey background, right-aligned bold values.
 * Matches the reference image's card containing Reference/Destination rows
 * and the in-card "Offer within 24 hours" callout.
 *
 * Pass the optional `callout` HTML (typically `offerCallout(...)`) to render
 * the inline green-bordered promise box at the bottom of the card.
 */
function detailsCard(
    rows: Array<{ label: string; value: string }>,
    callout?: string,
): string {
    // Card tokens — Brand Guidelines v2 §5.2 & §5.3:
    //   - §5.2 Selected/active row: light green background #F5F9E8
    //   - §5.3 Cards: 3px green top-accent for "emphasis cards"
    //   - §5.2 Borders: light grey #E0E0E0, 1px
    //   - Labels + values stay navy bold per §3 typography
    const CARD_BG     = '#F5F9E8';       // §5.2 active/selected row tint
    const CARD_BORDER = SETT_BORDER;     // §5.2 1px #E0E0E0
    const ROW_DIVIDER = '#E0E5C9';       // brand green tinted to match card
    const TOP_ACCENT  = SETT_GREEN;      // §5.3 3px green accent
    const TOP_ACCENT_PX = 3;

    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;background-color:${CARD_BG};border:1px solid ${CARD_BORDER};border-top:${TOP_ACCENT_PX}px solid ${TOP_ACCENT};border-radius:8px;">
      <tbody>
        ${rows.map((r, i) => {
            const isFirst = i === 0;
            const isLast = i === rows.length - 1 && !callout;
            const padTop = isFirst ? '20px' : '16px';
            const padBottom = isLast ? '20px' : '16px';
            const divider = i < rows.length - 1 ? `border-bottom:1px solid ${ROW_DIVIDER};` : '';
            return `
        <tr>
          <td style="padding:${padTop} 22px ${padBottom} 22px;font-family:${FONT_STACK};font-size:14px;font-weight:700;color:${SETT_NAVY};${divider}vertical-align:middle;">${r.label}</td>
          <td style="padding:${padTop} 22px ${padBottom} 22px;font-family:${FONT_STACK};font-size:14px;font-weight:700;color:${SETT_NAVY};text-align:right;${divider}vertical-align:middle;">${r.value}</td>
        </tr>`;
        }).join('')}
        ${callout ? `
        <tr>
          <td colspan="2" style="padding:14px 22px 20px 22px;">
            ${callout}
          </td>
        </tr>` : ''}
      </tbody>
    </table>`;
}

/**
 * Offer-within-24h callout — green left-border + soft tint background.
 * Renders inside the details card to mirror the reference image. The label
 * comes from the brand promise ("Offer within 24 hours") and the helper
 * line varies by context (customer enquiry vs. offer-ready, etc.).
 */
function offerCallout(label: string, helper?: string): string {
    return `
    <div style="border-left:3px solid ${SETT_GREEN};padding:8px 0 8px 14px;font-family:${FONT_STACK};">
      <div style="font-size:14px;font-weight:700;color:${SETT_NAVY};">${label}</div>
      ${helper ? `<div style="margin-top:4px;font-size:13px;font-weight:700;color:#4A4A4A;line-height:1.5;">${helper}</div>` : ''}
    </div>`;
}

/**
 * Sign-off block (left-aligned) — used at the bottom of email bodies.
 *
 *   mode = 'customer' (default) → matches the reference image's
 *     "Kind regards / S-E-T-T Groups / Reservations Team / LTD line /
 *     groups@s-e-t-t.com" stack. Use on customer-facing emails.
 *
 *   mode = 'staff' → terse internal signature ("— SETT Hub · automated
 *     notification") for internal alerts that shouldn't pretend to be
 *     personally signed by the Reservations Team.
 */
function signatureBlock(
    opts?: { mode?: 'customer' | 'staff'; teamLine?: string; entityLine?: string },
): string {
    const mode = opts?.mode ?? 'customer';

    if (mode === 'staff') {
        return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0 0;border-top:1px solid ${SETT_BORDER};">
      <tr>
        <td style="padding-top:16px;font-family:${FONT_STACK};font-size:12px;color:${SETT_GREY};line-height:1.5;">
          <div style="font-weight:600;color:${SETT_NAVY};">SETT Hub &middot; automated notification</div>
          <div style="margin-top:2px;">Sent from the SETT Hub Group Bookings backend &mdash; do not reply.</div>
        </td>
      </tr>
    </table>`;
    }

    const teamLine = opts?.teamLine ?? 'Reservations Team';
    const entityLine = opts?.entityLine ?? 'S-E-T-T Worldwide Reservation LTD';
    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0 0;border-top:1px solid ${SETT_BORDER};">
      <tr>
        <td style="padding-top:18px;font-family:${FONT_STACK};font-size:14px;color:${SETT_NAVY};line-height:1.6;">
          <div style="font-weight:700;color:${SETT_GREY};">Kind regards,</div>
          <div style="margin-top:6px;font-size:15px;font-weight:700;color:${SETT_NAVY};">S-E-T-T Groups</div>
          <div style="margin-top:2px;font-size:13px;font-weight:500;color:${SETT_GREY};">${teamLine}</div>
          <div style="margin-top:2px;font-size:13px;font-weight:500;color:${SETT_GREY};">${entityLine}</div>
          <div style="margin-top:8px;font-size:13px;">
            <a href="mailto:groups@s-e-t-t.com" style="color:${SETT_GREEN_DARK};text-decoration:none;font-weight:700;">groups@s-e-t-t.com</a>
          </div>
        </td>
      </tr>
    </table>`;
}

/**
 * "Did You Know?" promo card — green-bordered upsell shown only on
 * CUSTOMER-FACING emails (enquiry-received, offer-ready, etc.). Per
 * Oliver's reference image, this lives below the sign-off block and
 * promotes SETT's sports/event ticket service.
 *
 * Staff and system emails (alerts, status changes, generation failures)
 * intentionally skip this block — they need to stay signal-only.
 */
function didYouKnow(opts: {
    headline: string;
    body: string;
    cta?: { label: string; url: string };
}): string {
    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0 0;">
      <tr>
        <td style="border-top:2px solid ${SETT_GREEN};border-bottom:1px solid ${SETT_BORDER};background-color:${SETT_LIGHT_BG};padding:18px 22px;">
          <div style="font-family:${FONT_STACK};font-size:11px;font-weight:700;color:${SETT_GREEN_DARK};text-transform:uppercase;letter-spacing:0.12em;margin-bottom:8px;">Did you know?</div>
          <div style="font-family:${FONT_STACK};font-size:15px;font-weight:700;color:${SETT_NAVY};line-height:1.4;margin-bottom:8px;">${opts.headline}</div>
          <div style="font-family:${FONT_STACK};font-size:13px;color:${SETT_GREY};line-height:1.55;">${opts.body}</div>
          ${opts.cta ? `
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0 0 0;">
            <tr>
              <td style="background-color:${SETT_GREEN};border-radius:4px;">
                <a href="${opts.cta.url}" target="_blank" style="display:inline-block;padding:10px 22px;font-family:${FONT_STACK};font-size:12px;font-weight:700;color:${SETT_NAVY};text-decoration:none;text-transform:uppercase;letter-spacing:0.08em;">${opts.cta.label}</a>
              </td>
            </tr>
          </table>` : ''}
        </td>
      </tr>
    </table>`;
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
            ${subtitle(`${opts.contactName} &middot; ${opts.destinationName}`)}
            ${paragraph(`A new AI-generated group offer has been prepared and is waiting for your review.`)}
            ${detailsCard(
                [
                    { label: 'Reference', value: `#${opts.referenceNumber}` },
                    { label: 'Client', value: opts.contactName },
                    { label: 'Destination', value: opts.destinationName },
                ],
                offerCallout(
                    'Review required',
                    'This offer was generated automatically. Please review the hotel selection and pricing before approving.',
                ),
            )}
            ${ctaButton('Review Offer', url)}
            ${paragraph('Log in to the SETT Hub dashboard to review, adjust, and approve the offer.')}
            ${signatureBlock({ mode: 'staff' })}
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
            ${subtitle(`${opts.contactName} &middot; ${opts.destinationName}`)}
            ${paragraph('The AI pipeline could not fully satisfy this group request. A partial offer has been saved — manual intervention is required.')}
            ${detailsCard(
                [
                    { label: 'Reference', value: `#${opts.referenceNumber}` },
                    { label: 'Client', value: opts.contactName },
                    { label: 'Destination', value: opts.destinationName },
                ],
                offerCallout(
                    `${opts.roomsMissing} rooms short`,
                    `Coverage ${coveragePct}% — ${opts.roomsFound} of ${opts.roomsNeeded} requested rooms found across ${opts.hotelsAccepted} hotel(s).`,
                ),
            )}
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
            ${signatureBlock({ mode: 'staff' })}
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
        type: 'group',
        preheader: `Offer #${opts.referenceNumber} declined by ${opts.contactName}`,
        body: `
            ${heading('Offer Declined by Customer')}
            ${subtitle(`${opts.contactName} &middot; ${opts.destinationName}`)}
            ${paragraph('The customer has declined this offer. Review the reason below and follow up to understand or re-pitch.')}
            ${detailsCard(
                [
                    { label: 'Reference', value: `#${opts.referenceNumber}` },
                    { label: 'Client', value: opts.contactName },
                    { label: 'Destination', value: opts.destinationName },
                ],
                offerCallout(
                    'Customer reason',
                    opts.rejectionReason,
                ),
            )}
            ${ctaButton('Review & Revise', dashboardUrl)}
            ${paragraph('Open the offer in the dashboard to follow up or prepare a revised version.')}
            ${signatureBlock({ mode: 'staff' })}
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
            ${heading('Your group offer is ready')}
            ${subtitle(`Group accommodation offer &middot; ${opts.destinationName}`)}
            ${paragraph(`Dear ${opts.contactName},`)}
            ${paragraph(`Thank you for your enquiry. Please find attached your group accommodation offer for <strong>${opts.destinationName}</strong>.`)}
            ${detailsCard(
                [
                    { label: 'Reference', value: `#${opts.referenceNumber}` },
                    { label: 'Destination', value: opts.destinationName },
                ],
                offerCallout(
                    'Not yet confirmed',
                    'Hotel availability is limited and subject to change — reply to this email to confirm your booking.',
                ),
            )}
            ${paragraph('To confirm your booking or for any questions, please reply to this email or use the link below.')}
            ${ctaButton('Contact Us', `mailto:groups@s-e-t-t.com?subject=Offer%20%23${opts.referenceNumber}`)}
            ${signatureBlock()}
            ${didYouKnow({
                headline: 'We also handle sports &amp; event tickets for group sizes.',
                body: 'Champions League, F1, Wimbledon, NFL and more — bookable in group volumes alongside your accommodation.',
                cta: { label: 'Visit the Ticket Shop', url: 'https://www.s-e-t-t.com/tickets' },
            })}
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
            ${subtitle(`Reference #${opts.referenceNumber} &middot; manual action required`)}
            ${paragraph('The automated offer generation pipeline encountered an issue and could not complete.')}
            ${detailsCard(
                [
                    { label: 'Reference', value: `#${opts.referenceNumber}` },
                ],
                offerCallout(
                    'Reason',
                    opts.reason,
                ),
            )}
            ${ctaButton('Handle Manually', dashboardUrl)}
            ${paragraph('Please log in to the dashboard to create the offer manually.')}
            ${signatureBlock({ mode: 'staff' })}
        `,
    });
}

// ─── Phase 1 templates (Brevo SMTP rollout) ──────────────────────────────────
// All include the brand promise: "Offer within 24 hours" (renamed from
// "Quote" per Oliver's 2026-06-01 feedback — Oliver wants "Offer" used
// consistently in customer-facing copy).

/** Reusable promise line used at the bottom of every Phase 1 email body. */
function offerPromise(): string {
    return `<p style="margin:18px 0 0 0;font-family:${FONT_STACK};font-size:13px;font-weight:600;color:${SETT_NAVY};">Offer within 24 hours.</p>`;
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
            ${subtitle(`${opts.contactName} &middot; ${opts.destinationName}`)}
            ${paragraph(`A new group request has been received via <strong>${opts.source}</strong> and is ready to be processed.`)}
            ${detailsCard(
                rows.map((r) => ({ label: r.label, value: r.value.replace(/<[^>]+>/g, '') })),
                offerCallout(
                    'Offer within 24 hours',
                    'Open the request in the dashboard to review and respond.',
                ),
            )}
            ${ctaButton('Open Request', dashboardUrl)}
            ${signatureBlock({ mode: 'staff' })}
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
            ${subtitle(`Group accommodation request &middot; ${opts.destinationName}`)}
            ${paragraph(`Dear ${opts.contactName},`)}
            ${paragraph(`Thank you for choosing S-E-T-T Groups. We have received your group accommodation request for <strong>${opts.destinationName}</strong>, and our team is preparing your offer.`)}
            ${detailsCard(
                [
                    { label: 'Reference', value: `#${opts.referenceNumber}` },
                    { label: 'Destination', value: opts.destinationName },
                ],
                offerCallout(
                    'Offer within 24 hours',
                    'Our team is preparing your detailed offer.',
                ),
            )}
            <p style="margin:18px 0 0 0;font-family:${FONT_STACK};font-size:14px;font-weight:700;color:${SETT_GREY};line-height:1.6;">
              For any questions, please reply to this email.
            </p>
            ${signatureBlock()}
            ${didYouKnow({
                headline: 'We also handle sports &amp; event tickets for group sizes.',
                body: 'Champions League, F1, Wimbledon, NFL and more — bookable in group volumes alongside your accommodation.',
                cta: { label: 'Visit the Ticket Shop', url: 'https://www.s-e-t-t.com/tickets' },
            })}
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
            ${subtitle(`${opts.contactName} &middot; ${opts.destinationName}`)}
            ${paragraph(`This offer has been approved and is ready to be sent to the contact.`)}
            ${detailsCard(
                [
                    { label: 'Reference', value: `#${opts.referenceNumber}` },
                    { label: 'Client', value: opts.contactName },
                    { label: 'Destination', value: opts.destinationName },
                    { label: 'Approved by', value: opts.approvedBy },
                ],
                offerCallout(
                    'Ready to send',
                    'Open the offer in the dashboard to dispatch it to the customer.',
                ),
            )}
            ${ctaButton('Open Offer', dashboardUrl)}
            ${signatureBlock({ mode: 'staff' })}
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
            ${subtitle(`Group accommodation offer &middot; ${opts.destinationName}`)}
            ${paragraph(`Dear ${opts.contactName},`)}
            ${paragraph(`We are writing regarding your group accommodation enquiry for <strong>${opts.destinationName}</strong>.`)}
            ${detailsCard(
                [
                    { label: 'Reference', value: `#${opts.referenceNumber}` },
                    { label: 'Destination', value: opts.destinationName },
                ],
                offerCallout(
                    'Unable to proceed at this time',
                    opts.rejectionReason,
                ),
            )}
            ${paragraph('Please feel free to reply to this email if you would like to discuss alternatives or submit a new enquiry — we would be glad to help.')}
            ${signatureBlock()}
            ${didYouKnow({
                headline: 'We also handle sports &amp; event tickets for group sizes.',
                body: 'Champions League, F1, Wimbledon, NFL and more — bookable in group volumes alongside your accommodation.',
                cta: { label: 'Visit the Ticket Shop', url: 'https://www.s-e-t-t.com/tickets' },
            })}
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
            ${subtitle(`${opts.contactName} &middot; ${opts.destinationName}`)}
            ${detailsCard(
                [
                    { label: 'Reference', value: `#${opts.referenceNumber}` },
                    { label: 'Client', value: opts.contactName },
                    { label: 'Destination', value: opts.destinationName },
                ],
                offerCallout(
                    'Status change',
                    `${opts.fromStatus} &rarr; <strong style="color:${SETT_NAVY};">${opts.toStatus}</strong>`,
                ),
            )}
            ${ctaButton('Open Request', dashboardUrl)}
            ${signatureBlock({ mode: 'staff' })}
        `,
    });
}

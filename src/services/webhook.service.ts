/**
 * Webhook Service
 *
 * Handles inbound payloads from the SETT website Wix form:
 *   https://www.s-e-t-t.com/_api/form-submission-service/v4/submissions
 *   formId: cdd7652b-be36-4756-a985-9e390fa1477e
 *
 * Flow:
 *   1. Validate formId and required fields
 *   2. Map Wix form fields → BookingRequest schema
 *   3. Resolve destinationId by name from master.destinations
 *   4. Save booking request with status: pending
 *   5. Trigger async offer generation (background, non-blocking)
 */

import { PrismaClient, BookingRequestStatus } from '@prisma/client';
import offerGenerationService from './offerGeneration.service';
import notificationService, { resolveStaffNotificationEmail } from './notification.service';
import destinationRepository from '../repositories/destination.repository';
import { logAuditEvent } from '../utils/audit';
import logger from '../utils/logger';
import { parsePhoneWithCountryCode } from '../utils/phoneParser';

const prisma = new PrismaClient();

/** Expected Wix form ID — reject other forms. */
const EXPECTED_FORM_ID = 'cdd7652b-be36-4756-a985-9e390fa1477e';

/**
 * Default Terms & Conditions applied to every webhook-created booking request.
 *
 * Stored as HTML (`<ol><li>…</li></ol>`) to match the exact format the dashboard's
 * rich-text editor produces for portal-submitted requests. The dashboard renders
 * this with `dangerouslySetInnerHTML`, which is why plain-text with newlines would
 * collapse into a single paragraph. The "TERMS & CONDITIONS" heading is added by
 * the dashboard's section frame and is NOT part of the stored content.
 */
const DEFAULT_TERMS_AND_CONDITIONS =
    '<ol style="list-style-type: decimal; padding-left: 1.5rem;">' +
    '<li>All prices are per room per night unless otherwise stated</li>' +
    '<li>Prices are subject to availability at time of booking</li>' +
    '<li>Full payment required 30 days before arrival</li>' +
    '<li>Cancellation policy applies as per individual hotel terms</li>' +
    '<li>Group rates are valid for minimum 10 participants</li>' +
    '<li>Final room list required 14 days before arrival</li>' +
    '</ol>';

/** Default Cancellation Conditions paired with the terms above (same HTML format). */
const DEFAULT_CANCELLATION_CONDITIONS =
    '<ol style="list-style-type: decimal; padding-left: 1.5rem;">' +
    '<li>Cancellations made 14 days or more in advance of the event date will receive a 100% refund.</li>' +
    '<li>Cancellations made within 7 days will incur a 50% fee.</li>' +
    '</ol>';

// ─── Field parsers ─────────────────────────────────────────────────────────────

/**
 * Parse star rating from strings like:
 *   "3*", "Hotel 4*", "4 star", "4-star", "Hotel 4 Sterne" (DE),
 *   "Hotel 3⭐⭐⭐", "⭐⭐⭐⭐⭐", "Hotel 3 ★★★"
 */
function parseStarRating(raw: string | undefined | null): number | null {
    if (!raw) return null;

    // 1. Try: digit followed by a star symbol ( *, ⭐, ★, ☆ ) or "star"/"sterne"
    const withDigit =
        raw.match(/(\d)\s*[\*⭐★☆]/u) ??
        raw.match(/(\d)[-\s]*(?:star|sterne)/i) ??
        raw.match(/(?:star|sterne)[-\s]*(\d)/i);
    if (withDigit) return parseInt(withDigit[1]!, 10);

    // 2. Fallback: count star emojis/symbols when no digit is given
    //    (e.g. "⭐⭐⭐⭐" from a form that used only emoji).
    //    Limit to 1–7 to avoid matching random asterisk noise.
    const starSymbols = raw.match(/[⭐★]/gu);
    if (starSymbols && starSymbols.length >= 1 && starSymbols.length <= 7) {
        return starSymbols.length;
    }

    return null;
}

/**
 * Parse breakfast field → 'BB' | 'RO'
 * EN: "Yes, with breakfast" → BB, "No" → RO
 * DE: "Ja, mit Frühstück" → BB, "Nein, ohne Frühstück" → RO
 */
function parseBreakfast(raw: string | undefined | null): 'BB' | 'RO' {
    if (!raw) return 'RO';
    const s = raw.toLowerCase();
    // Explicit "no/nein/ohne" overrides any accidental match on "breakfast/frühstück"
    if (/\b(no|nein|ohne|without)\b/i.test(raw)) return 'RO';
    // Positive matches for English + German
    return /yes|ja|with breakfast|mit frühstück|breakfast|frühstück|fruhstuck/i.test(s)
        ? 'BB'
        : 'RO';
}

/**
 * Parse hotel_location → 'central' | 'outside_city_center'
 * EN: "City center" → central, "Outside the city" → outside_city_center
 * DE: "Stadtzentrum"/"Innenstadt" → central, "Außerhalb der Stadt" → outside_city_center
 */
function parseHotelLocation(raw: string | undefined | null): 'central' | 'outside_city_center' {
    if (!raw) return 'central';
    return /outside|save money|außerhalb|ausserhalb|außerstadt/i.test(raw)
        ? 'outside_city_center'
        : 'central';
}

/**
 * Canonical group_type codes recognised by the system. Frontend renders localised
 * labels for each via its i18n layer; the backend only ever stores/serves these codes.
 */
export type CanonicalGroupType =
    | 'business'
    | 'leisure'
    | 'sports'
    | 'youth'
    | 'school'
    | 'family'
    | 'wedding'
    | 'mice'
    // Retained so historic rows with this value still type-check; new inputs
    // are mapped to 'mice' instead.
    | 'conference'
    | 'other';

/**
 * Parse group_type → canonical code.
 * Accepts English variants, German labels, and historical inconsistencies.
 * Returns null for empty/null input; returns 'other' for unrecognised non-empty input.
 *
 * EN/legacy: "Business group", "business_group", "Corporate" → business
 * DE: "Geschäftsgruppe" → business, "Schulgruppe" → school, "Hochzeit" → wedding, etc.
 */
export function parseGroupType(raw: string | undefined | null): CanonicalGroupType | null {
    if (!raw) return null;
    const s = raw.toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (s === '') return null;

    // Order matters: more specific patterns first.
    if (/(school|schule|schulgruppe|klassenfahrt)/.test(s)) return 'school';
    if (/(youth|jugend|jugendgruppe)/.test(s)) return 'youth';
    if (/(business|corporate|gesch.?ftsgruppe|firmengruppe)/.test(s)) return 'business';
    if (/(leisure|reisegruppe|holiday|urlaub)/.test(s)) return 'leisure';
    if (/(sport|sportgruppe|mannschaft)/.test(s)) return 'sports';
    if (/(family|familie|familiengruppe)/.test(s)) return 'family';
    if (/(wedding|hochzeit|brautpaar)/.test(s)) return 'wedding';
    // MICE = Meetings, Incentives, Conferences, Exhibitions. Folds the
    // legacy 'conference' branch in; conference/kongress/tagung/meeting
    // are sub-cases of MICE and now share the same canonical bucket.
    if (/(mice|meetings_incentives|meetings|incentive|exhibition|firmenevent|firmenveranstaltung|firmen|conference|konferenz|tagung|kongress|meeting)/.test(s)) return 'mice';

    return 'other';
}

/**
 * Try to resolve a destination ID from a customer-supplied city name.
 *
 * Walks four match strategies (exact → startsWith → contains → firstWord)
 * via destinationRepository.resolveByName, picking the candidate with the
 * MOST hotel inventory at each tier. This prevents the "New York → New
 * York-NJ (0 hotels)" class of bug where the lowest-id duplicate wins over
 * the most-bookable destination.
 *
 * Returns id=0 when no match — staff can correct it from the dashboard.
 */
async function resolveDestinationId(cityName: string): Promise<{ id: number; name: string }> {
    const trimmed = cityName?.trim();
    if (!trimmed) return { id: 0, name: cityName };

    const result = await destinationRepository.resolveByName(trimmed);

    if (result.matchStrategy === 'none') {
        logger.warn({ cityName }, 'Webhook: destination not found in DB — stored with id=0');
        return { id: 0, name: trimmed };
    }

    if (result.hotelCount === 0) {
        logger.warn(
            {
                cityName,
                resolvedId: result.id,
                resolvedName: result.name,
                matchStrategy: result.matchStrategy,
            },
            'Webhook: resolved destination has zero hotel inventory — search will likely return no results',
        );
    }

    return { id: result.id, name: result.name };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class WebhookService {
    async processWebhook(payload: any, ip: string) {
        // Dry-run mode: run all validation + parsing but do NOT persist or trigger
        // offer generation. Used by integration partners to verify field mapping
        // without polluting the database. Accept the flag from either the outer
        // wrapper payload or from inside `data` (depends on how the caller wraps it).
        const dryRun =
            payload?.dryRun === true ||
            payload?.dry_run === true ||
            payload?.data?.dryRun === true ||
            payload?.data?.dry_run === true;

        // 1. Validate formId
        if (payload.formId && payload.formId !== EXPECTED_FORM_ID) {
            logger.warn({ formId: payload.formId }, 'Webhook received with unexpected formId');
            throw { status: 400, message: 'Unknown form ID', code: 'UNKNOWN_FORM' };
        }

        const data = payload.data ?? payload; // support both wrapped and flat payloads
        const submissionId: string | undefined = payload.submissionId ?? payload.submission_id;

        // 2. Parse dates
        const checkinDate = data.arrival_date ?? data.checkin_date ?? data.CheckInDate;
        const checkoutDate = data.departure_date ?? data.checkout_date ?? data.CheckOutDate;

        if (!checkinDate) {
            throw { status: 400, message: 'arrival_date is required', code: 'MISSING_FIELD' };
        }

        const checkin = new Date(checkinDate);
        if (isNaN(checkin.getTime())) {
            throw { status: 400, message: 'arrival_date is not a valid date', code: 'INVALID_DATE' };
        }
        const checkout = checkoutDate ? new Date(checkoutDate) : null;
        if (checkout && isNaN(checkout.getTime())) {
            throw { status: 400, message: 'departure_date is not a valid date', code: 'INVALID_DATE' };
        }
        if (checkout && checkout.getTime() <= checkin.getTime()) {
            throw {
                status: 400,
                message: 'departure_date must be after arrival_date',
                code: 'INVALID_DATE_RANGE',
            };
        }
        const nights = checkout
            ? Math.max(1, Math.round((checkout.getTime() - checkin.getTime()) / 86_400_000))
            : 1;

        // 2b. Validate email — required and must be a plausible email format
        const rawEmail: string | undefined = data.email ?? data.contactEmail;
        if (!rawEmail || typeof rawEmail !== 'string' || rawEmail.trim() === '') {
            throw { status: 400, message: 'email is required', code: 'MISSING_FIELD' };
        }
        const emailNormalized = rawEmail.trim().toLowerCase();
        // Simple RFC-5322-ish check: local@domain.tld
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalized)) {
            throw { status: 400, message: 'email is not a valid email address', code: 'INVALID_EMAIL' };
        }

        // 2c. Idempotency — reject duplicate submissionId (if provided).
        // Skipped in dry-run so partners can safely replay the same test payload.
        if (submissionId && !dryRun) {
            const existing = await prisma.bookingRequest.findFirst({
                where: { externalRequestId: submissionId },
                select: { id: true, referenceNumber: true, status: true },
            });
            if (existing) {
                logger.info(
                    { submissionId, existingId: existing.id },
                    'Webhook: duplicate submissionId — returning existing request',
                );
                return {
                    id: existing.id,
                    referenceNumber: (existing as any).referenceNumber,
                    status: existing.status,
                    destinationName: null,
                    message: 'Request already received — returning existing record (idempotent).',
                    duplicate: true,
                };
            }
        }

        // 3. Resolve destination
        const rawCity: string = data.destination_by_city ?? data.destination ?? data.DestinationName ?? '';
        const destination = await resolveDestinationId(rawCity);

        // 4. Parse room counts from individual fields
        const rooms = {
            single: Number(data.how_many_single_rooms ?? 0),
            double: Number(data.how_many_double_rooms ?? 0),
            triple: Number(data.how_many_triple_rooms ?? 0),
            quadruple: Number(data.how_many_quadruple_rooms ?? 0),
            twin: 0,
            suites: 0,
            extraRoomsNote:
                data.extra_rooms && data.extra_rooms !== 'NA' && data.extra_rooms !== 'N/A'
                    ? String(data.extra_rooms)
                    : null,
        };

        const totalRooms = rooms.single + rooms.double + rooms.triple + rooms.quadruple;
        const groupSize = totalRooms > 0 ? totalRooms : null;

        // 5. Parse other fields
        const starRating = parseStarRating(data.hotel_category);
        const breakfastPreference = parseBreakfast(data.breakfast);
        const hotelLocation = parseHotelLocation(data.hotel_location);

        const firstName: string = data.first_name ?? data.firstName ?? '';
        const lastName: string = data.last_name ?? data.lastName ?? '';
        const contactName = [firstName, lastName].filter(Boolean).join(' ') || null;

        // 6. Create the booking request — ownership stays unassigned; first staff
        // action (or explicit /claim) will set assignedUserId.
        const requestPayload = {
            rawPayload: payload,
            externalRequestId: submissionId ?? null,
            source: 'webhook',
            sourceIp: ip,
            assignedUserId: null,

            // Trip details
            destinationId: destination.id,
            destinationName: destination.name || rawCity,
            checkinDate: checkin,
            checkoutDate: checkout ?? undefined,
            nights,
            // Wix sends ONE star value. Persist it both on the legacy single
            // field AND wrapped into the new `starRatings` array so the
            // search pipeline (which prefers the array) treats it as a
            // single-entry multi-select.
            starRating: starRating ?? undefined,
            starRatings: starRating != null ? [starRating] : [],
            budgetRange: data.budget ? String(data.budget) : null,
            groupType: parseGroupType(data.group_type),
            groupSize,
            averageAge: data.average_age != null ? Number(data.average_age) : null,
            currencyCode: 'EUR',
            // Nationality drives the WBE rate-card selection — different
            // nationalities see different prices for the same hotel.
            // Wix should send `nationality_code` as an ISO-style code
            // (e.g. 'DE', 'AE', 'HU') matching `master.nationalities.code`.
            // If absent the row is created null and the hotel-search
            // resolver applies a cutoff-date guard (see
            // hotelSearch.service.ts:resolveNationalityCode). Coordinate
            // with the Wix form owner to add this field.
            nationalityCode:
                (typeof data.nationality_code === 'string' && data.nationality_code.trim()) ||
                (typeof data.nationalityCode === 'string' && data.nationalityCode.trim()) ||
                null,

            // Room & accommodations
            rooms,
            breakfastPreference,
            hotelLocation,
            specialRequirements: data.extras ?? data.special_requirements ?? null,

            // Customer details
            companyName: data.company_name ?? data.companyName ?? null,
            firstName: firstName || null,
            lastName: lastName || null,
            contactName,
            contactEmail: emailNormalized,
            ...(() => {
                const parsed = parsePhoneWithCountryCode(data.phone ?? data.contactPhone);
                return {
                    contactPhone: parsed.number || null,
                    contactPhoneCountryCode: parsed.countryCode,
                };
            })(),
            guestListFileKey:
                data.name_list && typeof data.name_list === 'string' ? data.name_list : null,

            // Step 4 – Policies — webhook submissions don't carry these, so apply
            // the same static defaults the dashboard portal uses. Staff can edit
            // them per-request afterwards if needed.
            termsAndConditions: DEFAULT_TERMS_AND_CONDITIONS,
            cancellationConditions: DEFAULT_CANCELLATION_CONDITIONS,

            status: BookingRequestStatus.pending,
        };

        if (!requestPayload.nationalityCode) {
            logger.warn(
                {
                    submissionId: submissionId ?? null,
                    email: emailNormalized,
                    formId: payload?.formId ?? null,
                },
                'Wix webhook payload missing nationality_code — request saved with null. ' +
                    'Hotel search will reject post-cutoff or fall back to HU for legacy rows. ' +
                    'Update the Wix form to send nationality_code.',
            );
        }

        // Dry-run: return the simulated payload without persisting or triggering
        // offer generation. All validation & parsing above has already run, so
        // partners get full parity with real-mode errors.
        if (dryRun) {
            logger.info(
                {
                    destinationName: requestPayload.destinationName,
                    destinationId: requestPayload.destinationId,
                    email: requestPayload.contactEmail,
                    rooms,
                    breakfastPreference,
                    hotelLocation,
                    starRating,
                },
                'Webhook dry-run received',
            );
            const { rawPayload: _rawPayload, sourceIp: _sourceIp, assignedUserId: _assigned, status: _status, ...wouldCreate } = requestPayload;
            return {
                mode: 'dryRun',
                valid: true,
                wouldCreate,
                message: 'Dry-run validation successful. No BookingRequest created.',
            };
        }

        const bookingRequest = await prisma.bookingRequest.create({
            data: requestPayload as any,
        });

        logger.info(
            {
                requestId: bookingRequest.id,
                referenceNumber: (bookingRequest as any).referenceNumber,
                destination: destination.name,
                submissionId,
            },
            'Webhook booking request created',
        );

        await logAuditEvent({
            action: 'webhook_request_received',
            entity: 'booking_request',
            entityId: bookingRequest.id,
            details: {
                submissionId,
                formId: payload.formId,
                destinationName: destination.name,
                companyName: requestPayload.companyName,
            },
            ipAddress: ip,
        });

        // 7. Fire transactional notifications (staff alert + customer confirmation).
        // Fire-and-forget — never block the webhook response on email delivery.
        const refNum = (bookingRequest as any).referenceNumber as number;
        const displayName = (requestPayload as any).contactName ?? (requestPayload as any).companyName ?? 'Customer';
        const staffEmail = resolveStaffNotificationEmail();

        // Webhooks can come from Wix (default) or WordPress (delegated via wordpressWebhook.service).
        // The delegating service sets `source: 'wordpress'` on the payload it forwards.
        const webhookSource: 'wix' | 'wordpress' = payload?.source === 'wordpress' ? 'wordpress' : 'wix';

        if (staffEmail) {
            void notificationService
                .notifyNewRequestStaff({
                    requestId: bookingRequest.id,
                    referenceNumber: refNum,
                    contactName: displayName,
                    destinationName: destination.name,
                    source: webhookSource,
                    staffEmail,
                    groupType: (bookingRequest as any).groupType ?? null,
                    averageAge: (bookingRequest as any).averageAge ?? null,
                })
                .catch((err) => logger.warn({ err: err.message, id: bookingRequest.id }, 'Webhook notifyNewRequestStaff failed'));
        }
        const contactEmail = (requestPayload as any).contactEmail;
        if (contactEmail) {
            void notificationService
                .notifyNewRequestContact({
                    requestId: bookingRequest.id,
                    referenceNumber: refNum,
                    contactEmail,
                    contactName: displayName,
                    destinationName: destination.name,
                })
                .catch((err) => logger.warn({ err: err.message, id: bookingRequest.id }, 'Wix notifyNewRequestContact failed'));
        }

        // 8. Trigger async offer generation (non-blocking)
        offerGenerationService.triggerAsync(bookingRequest.id);

        return {
            id: bookingRequest.id,
            referenceNumber: (bookingRequest as any).referenceNumber,
            status: bookingRequest.status,
            destinationName: destination.name,
            message: 'Request received. Offer generation in progress.',
        };
    }
}

export default new WebhookService();

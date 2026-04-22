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
import { logAuditEvent } from '../utils/audit';
import logger from '../utils/logger';
import { parsePhoneWithCountryCode } from '../utils/phoneParser';

const prisma = new PrismaClient();

/** Expected Wix form ID — reject other forms. */
const EXPECTED_FORM_ID = 'cdd7652b-be36-4756-a985-9e390fa1477e';

// ─── Field parsers ─────────────────────────────────────────────────────────────

/**
 * Parse "Hotel 3* ⭐️⭐️⭐️" → 3
 * Accepts patterns like "3*", "Hotel 4*", "4 star", "4-star", "Hotel 4 Sterne" (DE)
 */
function parseStarRating(raw: string | undefined | null): number | null {
    if (!raw) return null;
    // Try: "4*" or "4 star" or "4 Sterne" or "4-star" or "4 stars"
    const m =
        raw.match(/(\d)\s*\*/) ??
        raw.match(/(\d)[-\s]*(?:star|sterne)/i) ??
        raw.match(/(?:star|sterne)[-\s]*(\d)/i);
    return m ? parseInt(m[1]!, 10) : null;
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
 * Try to resolve destination ID from city name.
 * Strategy (in order of preference):
 *   1. EXACT case-insensitive match ("Dubai" → "Dubai", not "Dubai Airports")
 *   2. "Starts with" match ("Dubai" → "Dubai Marina")
 *   3. "Contains" match as last resort
 * Returns 0 if not found (stored as unresolved — staff can correct manually).
 */
async function resolveDestinationId(cityName: string): Promise<{ id: number; name: string }> {
    const name = cityName?.trim();
    if (!name) return { id: 0, name: cityName };

    // 1. Exact (case-insensitive) match — prefer this
    const exact = await prisma.destination.findFirst({
        where: { name: { equals: name, mode: 'insensitive' } },
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
    });
    if (exact) return { id: exact.id, name: exact.name };

    // 2. Starts-with match — e.g. "Dubai" → "Dubai Marina"
    const startsWith = await prisma.destination.findFirst({
        where: { name: { startsWith: name, mode: 'insensitive' } },
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
    });
    if (startsWith) return { id: startsWith.id, name: startsWith.name };

    // 3. Contains match — last resort
    const contains = await prisma.destination.findFirst({
        where: { name: { contains: name, mode: 'insensitive' } },
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
    });
    if (contains) return { id: contains.id, name: contains.name };

    // 4. Fallback: try first-word search
    const firstWord = name.split(/\s+/)[0];
    if (firstWord && firstWord !== name) {
        const partial = await prisma.destination.findFirst({
            where: { name: { contains: firstWord, mode: 'insensitive' } },
            select: { id: true, name: true },
            orderBy: { id: 'asc' },
        });
        if (partial) return { id: partial.id, name: partial.name };
    }

    logger.warn({ cityName }, 'Webhook: destination not found in DB — stored with id=0');
    return { id: 0, name };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class WebhookService {
    async processWebhook(payload: any, ip: string) {
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

        // 2c. Idempotency — reject duplicate submissionId (if provided)
        if (submissionId) {
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
            starRating: starRating ?? undefined,
            budgetRange: data.budget ? String(data.budget) : null,
            groupType: data.group_type ?? null,
            groupSize,
            averageAge: data.average_age != null ? Number(data.average_age) : null,
            currencyCode: 'EUR',

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

            status: BookingRequestStatus.pending,
        };

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

        // 7. Trigger async offer generation (non-blocking)
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

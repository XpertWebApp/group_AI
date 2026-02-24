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

const prisma = new PrismaClient();

/** Expected Wix form ID — reject other forms. */
const EXPECTED_FORM_ID = 'cdd7652b-be36-4756-a985-9e390fa1477e';

// ─── Field parsers ─────────────────────────────────────────────────────────────

/**
 * Parse "Hotel 3* ⭐️⭐️⭐️" → 3
 * Accepts patterns like "3*", "Hotel 4*", "4 star", "4-star"
 */
function parseStarRating(raw: string | undefined | null): number | null {
    if (!raw) return null;
    const m = raw.match(/(\d)[\s*]?[\s*star]/i) ?? raw.match(/(\d)\*/);
    return m ? parseInt(m[1]!, 10) : null;
}

/**
 * Parse breakfast field → 'BB' | 'RO'
 * "Yes, with breakfast" → "BB"
 * "No, without breakfast" → "RO"
 */
function parseBreakfast(raw: string | undefined | null): 'BB' | 'RO' {
    if (!raw) return 'RO';
    return /yes|with breakfast|breakfast/i.test(raw) ? 'BB' : 'RO';
}

/**
 * Parse hotel_location → 'central' | 'outside_city_center'
 * "Save money – stay outside the city center" → "outside_city_center"
 */
function parseHotelLocation(raw: string | undefined | null): 'central' | 'outside_city_center' {
    if (!raw) return 'central';
    return /outside|outside the city|save money/i.test(raw) ? 'outside_city_center' : 'central';
}

/**
 * Try to resolve destination ID from city name (case-insensitive, partial match).
 * Returns 0 if not found (stored as unresolved — staff can correct manually).
 */
async function resolveDestinationId(cityName: string): Promise<{ id: number; name: string }> {
    if (!cityName?.trim()) return { id: 0, name: cityName };

    const dest = await prisma.destination.findFirst({
        where: { name: { contains: cityName.trim(), mode: 'insensitive' } },
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
    });

    if (dest) return { id: dest.id, name: dest.name };

    // Fallback: try a word-boundary search on the first word of the city name
    const firstWord = cityName.trim().split(/\s+/)[0];
    if (firstWord && firstWord !== cityName.trim()) {
        const partial = await prisma.destination.findFirst({
            where: { name: { contains: firstWord, mode: 'insensitive' } },
            select: { id: true, name: true },
            orderBy: { id: 'asc' },
        });
        if (partial) return { id: partial.id, name: partial.name };
    }

    logger.warn({ cityName }, 'Webhook: destination not found in DB — stored with id=0');
    return { id: 0, name: cityName.trim() };
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
        const checkout = checkoutDate ? new Date(checkoutDate) : null;
        const nights = checkout
            ? Math.max(1, Math.round((checkout.getTime() - checkin.getTime()) / 86_400_000))
            : 1;

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

        // 6. Create the booking request
        const requestPayload = {
            rawPayload: payload,
            externalRequestId: submissionId ?? null,
            source: 'webhook',
            sourceIp: ip,

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
            contactEmail: data.email ?? data.contactEmail ?? null,
            contactPhone: data.phone ?? data.contactPhone ?? null,
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

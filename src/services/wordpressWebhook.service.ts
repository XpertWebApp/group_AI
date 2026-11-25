/**
 * WordPress Webhook Service
 *
 * Receives a WordPress-shaped payload (new group form at https://www.s-e-t-t.com/groups/),
 * normalizes field names to match our existing Wix payload shape, and delegates to
 * `webhookService.processWebhook()` so all the core logic (destination resolution,
 * phone parsing, star-rating parsing, offer generation trigger) is reused.
 *
 * WordPress form fields (as of 2026-04-15) vs. our internal keys:
 *   destination            → destination_by_city
 *   arrival_date           → arrival_date (same)
 *   departure_date         → departure_date (same)
 *   hotel_category         → hotel_category (same)
 *   group_type             → group_type (same)
 *   single_rooms           → how_many_single_rooms
 *   double_rooms           → how_many_double_rooms
 *   triple_rooms           → how_many_triple_rooms
 *   quadruple_rooms        → how_many_quadruple_rooms
 *   extra_rooms            → extra_rooms (same)
 *   breakfast              → breakfast (same)
 *   budget                 → budget (same)
 *   extras                 → extras (same)
 *   name_list              → name_list (must be a URL string; binary/base64 not accepted)
 *   company_name           → company_name (same)
 *   first_name             → first_name (same)
 *   last_name              → last_name (same)
 *   email                  → email (same)
 *   phone                  → phone (same)
 */

import webhookService from './webhook.service';
import logger from '../utils/logger';

export class WordpressWebhookService {
    async processWordpressWebhook(payload: any, ip: string) {
        const normalized = this.normalizePayload(payload);

        logger.info(
            {
                destination: normalized.destination_by_city,
                email: normalized.email,
                source: 'wordpress',
            },
            'WordPress webhook: payload normalized, delegating to core webhook service',
        );

        // Delegate to existing Wix-shaped processor.
        // Wrap in { data: ... } because the Wix service supports both wrapped and flat.
        // We also mark source = 'wordpress' so audit logs can tell them apart.
        return webhookService.processWebhook(
            {
                source: 'wordpress',
                submissionId: payload.submissionId ?? payload.submission_id ?? undefined,
                rawWordpressPayload: payload,  // preserved in rawPayload for audit
                // Forward the dryRun flag from the WordPress root payload so the
                // core webhook service can skip DB write + offer trigger.
                dryRun: payload?.dryRun === true || payload?.dry_run === true,
                data: normalized,
            },
            ip,
        );
    }

    /**
     * Convert WordPress field names to the keys expected by webhook.service.ts.
     * Uses fallbacks: if a WordPress-only key is missing, falls back to the
     * matching Wix key (lets us accept either format).
     */
    private normalizePayload(payload: any): Record<string, any> {
        const p = payload?.data ?? payload ?? {};

        return {
            // Destination
            destination_by_city: p.destination ?? p.destination_by_city ?? p.DestinationName ?? null,

            // Dates
            arrival_date: p.arrival_date ?? p.checkin_date ?? p.CheckInDate ?? null,
            departure_date: p.departure_date ?? p.checkout_date ?? p.CheckOutDate ?? null,

            // Trip details
            hotel_category: p.hotel_category ?? null,
            group_type: p.group_type ?? null,
            budget: p.budget ?? null,
            average_age: p.average_age ?? null,

            // Rooms — this is the main WordPress rename
            how_many_single_rooms: p.single_rooms ?? p.how_many_single_rooms ?? 0,
            how_many_double_rooms: p.double_rooms ?? p.how_many_double_rooms ?? 0,
            how_many_triple_rooms: p.triple_rooms ?? p.how_many_triple_rooms ?? 0,
            how_many_quadruple_rooms: p.quadruple_rooms ?? p.how_many_quadruple_rooms ?? 0,
            extra_rooms: p.extra_rooms ?? null,

            // Accommodations
            breakfast: p.breakfast ?? null,
            hotel_location: p.hotel_location ?? null,

            // Customer
            company_name: p.company_name ?? p.companyName ?? null,
            first_name: p.first_name ?? p.firstName ?? null,
            last_name: p.last_name ?? p.lastName ?? null,
            email: p.email ?? p.contactEmail ?? null,
            phone: p.phone ?? p.contactPhone ?? null,

            // Special requirements
            extras: p.extras ?? p.special_requirements ?? null,

            // Guest list — must be a URL string when WordPress sends it
            name_list: typeof p.name_list === 'string' ? p.name_list : null,
        };
    }
}

export default new WordpressWebhookService();

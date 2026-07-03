import proposalRepository from '../repositories/proposal.repository';
import notificationService, { resolveStaffNotificationEmail } from './notification.service';
import { generateOfferPdf, OfferPdfData } from './pdfGeneration.service';
import requestRepository from '../repositories/request.repository';
import requestsService from './requests.service';
import settingsService from './settings.service';
import { logAuditEvent } from '../utils/audit';
import { ProposalStatus } from '@prisma/client';
import { countTotalRooms } from '../utils/roomUtils';
import logger from '../utils/logger';
import storageService from './storage.service';
import config from '../config';
import { PdfLanguage } from '../i18n/pdfTranslations';
import { translateBatch } from './translation.service';
import { resolveHotelImagesForPdf } from '../utils/hotelImageForPdf';
import { resolveHotelEnrichmentForPdf, type PdfLanguageCode } from '../utils/hotelEnrichmentForPdf';
import { resolveHotelEnrichmentForFe } from '../utils/hotelEnrichmentForFe';

// Proposals are editable in `draft` (staff is still building it) AND in
// `pending_admin_approval` (waiting for admin sign-off — staff can still adjust
// the AI-generated set or add/remove hotels). Once the proposal is `approved`,
// `sent`, or `declined`, edits are blocked. This matches `APPROVABLE_STATUSES`
// and `DECLINABLE_STATUSES` which already treat both states as non-terminal.
const MODIFIABLE_STATUSES: ProposalStatus[] = [
    ProposalStatus.draft,
    ProposalStatus.pending_admin_approval,
];
// Selection toggles (includedInTotal) are also allowed on sent proposals,
// because after the initial offer is sent the staff needs to pick the client's
// chosen hotel/services and re-send a final offer.
const SELECTION_MODIFIABLE_STATUSES: ProposalStatus[] = [
    ProposalStatus.draft,
    ProposalStatus.sent,
];
// `sent` is approvable too — after the initial offer goes out, staff toggles hotels
// and re-approves before sending the final offer.
const APPROVABLE_STATUSES: ProposalStatus[] = [
    ProposalStatus.pending_admin_approval,
    ProposalStatus.draft,
    ProposalStatus.sent,
];
// Decline is allowed at more stages than approve — including after the offer was sent,
// because clients may reject the offer after receiving it.
const DECLINABLE_STATUSES: ProposalStatus[] = [
    ProposalStatus.draft,
    ProposalStatus.pending_admin_approval,
    ProposalStatus.approved,
    ProposalStatus.sent,
];

function assertModifiable(proposal: any) {
    if (!MODIFIABLE_STATUSES.includes(proposal.status)) {
        throw {
            status: 409,
            message: `Proposal cannot be modified in status '${proposal.status}'`,
            code: 'PROPOSAL_NOT_MODIFIABLE',
        };
    }
}

/**
 * Selection-only guard: allows `includedInTotal` toggling even after the
 * proposal was sent, so staff can pick the client's chosen hotel/services
 * and trigger the final offer. Destructive edits (price/content changes)
 * still go through `assertModifiable`.
 */
function assertSelectionEditable(proposal: any) {
    if (!SELECTION_MODIFIABLE_STATUSES.includes(proposal.status)) {
        throw {
            status: 409,
            message: `Proposal selection cannot be changed in status '${proposal.status}'`,
            code: 'PROPOSAL_NOT_MODIFIABLE',
        };
    }
}

function assertNotLocked(proposal: any, requestingUserId?: string) {
    const LOCK_TIMEOUT_MS = 15 * 60 * 1000;
    if (
        proposal.lockedBy &&
        proposal.lockedBy !== requestingUserId &&
        proposal.lockedAt &&
        Date.now() - new Date(proposal.lockedAt).getTime() < LOCK_TIMEOUT_MS
    ) {
        throw {
            status: 409,
            message: 'Proposal is currently locked by another user',
            code: 'PROPOSAL_LOCKED',
            owner: { id: proposal.lockedBy, lockedAt: proposal.lockedAt },
        };
    }
}

export class ProposalService {
    /**
     * Fire-and-forget owner-claim on the underlying BookingRequest — called at
     * the start of every mutating proposal action so the first staff member to
     * touch the request becomes its owner. No-ops if requestId/userId missing
     * or the request is already owned.
     */
    private claimForRequest(requestId: string | null | undefined, userId?: string, ip?: string) {
        if (userId && requestId) {
            void requestsService.claimOwnershipIfUnassigned(requestId, userId, ip, 'auto');
        }
    }

    async getAllProposals() {
        return proposalRepository.findAll();
    }

    async getProposalById(id: string, opts?: { language?: 'en' | 'de' }) {
        const proposal = await proposalRepository.findById(id);
        if (!proposal) {
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        }

        // Enrich each hotel row with the three fields the FE Hotel Card
        // needs but ProposalHotel doesn't persist directly:
        //   - imageUrl     (GIATA-priority proxy URL, WBE fallback)
        //   - description  (GIATA short text in requested lang, WBE meta fallback)
        //   - facilities[] (brand-priority capped list)
        //
        // Done in one parallel batch so the response latency is bounded by
        // the slowest single query. Failure-isolated per the helper — a
        // hotel without enrichment data falls back to nulls and renders a
        // placeholder card on the FE.
        const hotels = (proposal as any).hotels ?? [];
        const hotelCodes = hotels.map((h: any) => h.hotelCode).filter(Boolean);

        if (hotelCodes.length === 0) return proposal;

        const language: PdfLanguageCode = opts?.language === 'de' ? 'de' : 'en';
        const enrichmentByCode = await resolveHotelEnrichmentForFe(hotelCodes, language);

        const enrichedHotels = hotels.map((h: any) => {
            const enrichment = enrichmentByCode.get(h.hotelCode) ?? {
                imageUrl: null,
                description: null,
                facilities: [],
            };
            // Derived field for FE convenience: the date to actually show
            // the customer is the override when present, otherwise the
            // supplier's date. The FE can also read the raw cancelDeadline
            // and cancelDeadlineOverride separately when it needs to display
            // the "supplier vs override" comparison row.
            const effectiveCancelDeadline =
                h.cancelDeadlineOverride ?? h.cancelDeadline ?? null;

            return {
                ...h,
                imageUrl: enrichment.imageUrl,
                description: enrichment.description,
                facilities: enrichment.facilities,
                effectiveCancelDeadline,
            };
        });

        return { ...(proposal as any), hotels: enrichedHotels };
    }

    async createProposal(data: any) {
        return proposalRepository.create(data);
    }

    async createForRequest(requestId: string, data: any, userId?: string, ip?: string) {
        const proposal = await proposalRepository.createForRequest(requestId, data);

        await logAuditEvent({
            userId,
            action: 'create_proposal',
            entity: 'proposal',
            entityId: proposal.id,
            details: { requestId },
            ipAddress: ip,
        });

        return proposal;
    }

    async updateMetadata(id: string, data: any, userId?: string) {
        const existing = await proposalRepository.findById(id);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        assertModifiable(existing);
        assertNotLocked(existing, userId);

        const updated = await proposalRepository.updateMetadata(id, data);

        await logAuditEvent({
            userId,
            action: 'update_proposal',
            entity: 'proposal',
            entityId: id,
            details: { fields: Object.keys(data) },
        });

        return updated;
    }

    async addHotelToProposal(id: string, hotelData: any, userId?: string, ip?: string) {
        const existing = await proposalRepository.findById(id);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        assertModifiable(existing);
        assertNotLocked(existing, userId);
        this.claimForRequest(existing.requestId, userId, ip);

        const result = await proposalRepository.addHotelTx(
            id,
            hotelData,
            (existing.markupSettings as any) ?? undefined,
        );

        await logAuditEvent({
            userId,
            action: 'add_hotel',
            entity: 'proposal_hotel',
            entityId: result.hotel.id,
            details: {
                proposalId: id,
                hotelCode: hotelData.hotelCode,
                totalPrice: hotelData.totalPrice,
                optionDetailsFetched: result.hotel.optionDetailsFetched,
            },
            ipAddress: ip,
        });

        return result;
    }

    async removeHotelFromProposal(proposalId: string, hotelId: string, userId?: string) {
        const existing = await proposalRepository.findById(proposalId);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };

        if (existing.status === ProposalStatus.sent) {
            throw {
                status: 409,
                message: 'Cannot remove hotels from a sent proposal',
                code: 'PROPOSAL_NOT_MODIFIABLE',
            };
        }
        assertNotLocked(existing, userId);
        this.claimForRequest(existing.requestId, userId);

        const hotel = existing.hotels.find((h: any) => h.id === hotelId);
        if (!hotel) throw { status: 404, message: 'Hotel not found on this proposal', code: 'NOT_FOUND' };

        const result = await proposalRepository.removeHotelTx(proposalId, hotelId, hotel);

        await logAuditEvent({
            userId,
            action: 'remove_hotel',
            entity: 'proposal_hotel',
            entityId: hotelId,
            details: { proposalId, snapshot: hotel },
        });

        return result;
    }

    async listHotels(proposalId: string) {
        const proposal = await proposalRepository.findById(proposalId);
        if (!proposal) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        return proposalRepository.findHotels(proposalId);
    }

    /**
     * Set or clear the cancellation-deadline override on a single proposal
     * hotel. Pass `cancelDeadlineOverride: null` to clear (reverts customer-
     * facing display back to the supplier's date).
     *
     * Guard rules:
     *  1. The proposal must exist.
     *  2. The hotel must belong to that proposal.
     *  3. The proposal must be modifiable (not sent / declined / etc.) and
     *     not locked by another user.
     *  4. **Override date must be earlier than the supplier's `cancelDeadline`.**
     *     Staff can be more conservative (promise customer 20 Dec when
     *     supplier says 23 Dec) but cannot promise a later date than the
     *     supplier will honour — that would expose SETT to the full
     *     cancellation penalty.
     *  5. Override date must not be in the past.
     *
     * Audit-logged with both old and new values so disputes are traceable.
     */
    async updateHotelCancellation(
        proposalId: string,
        hotelId: string,
        params: { cancelDeadlineOverride: string | null },
        userId?: string,
        ip?: string,
    ) {
        const existing = await proposalRepository.findById(proposalId);
        if (!existing) {
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        }
        assertModifiable(existing);
        assertNotLocked(existing, userId);
        this.claimForRequest(existing.requestId, userId, ip);

        const hotel = (existing.hotels ?? []).find((h: any) => h.id === hotelId);
        if (!hotel) {
            throw {
                status: 404,
                message: 'Hotel not found on this proposal',
                code: 'NOT_FOUND',
            };
        }

        const newOverride = params.cancelDeadlineOverride
            ? new Date(params.cancelDeadlineOverride)
            : null;

        // Guard 4: override must be EARLIER than supplier's date.
        if (newOverride !== null) {
            const supplierDate = (hotel as any).cancelDeadline
                ? new Date((hotel as any).cancelDeadline)
                : null;
            if (supplierDate && newOverride.getTime() >= supplierDate.getTime()) {
                throw {
                    status: 400,
                    message:
                        "Override date must be earlier than the supplier's cancellation deadline (" +
                        supplierDate.toISOString().slice(0, 10) +
                        '). Staff can promise an earlier cancellation date, but not a later one — SETT would be exposed to the full supplier penalty.',
                    code: 'CXL_OVERRIDE_TOO_LATE',
                    supplierDeadline: supplierDate.toISOString(),
                };
            }

            // Guard 5: not in the past.
            const today = new Date();
            today.setUTCHours(0, 0, 0, 0);
            if (newOverride.getTime() < today.getTime()) {
                throw {
                    status: 400,
                    message: 'Override date cannot be in the past.',
                    code: 'CXL_OVERRIDE_IN_PAST',
                };
            }
        }

        if (!userId) {
            throw {
                status: 401,
                message: 'Authenticated user required to set override',
                code: 'UNAUTHORIZED',
            };
        }

        const result = await proposalRepository.updateHotelCancellation(hotelId, {
            cancelDeadlineOverride: newOverride,
            overriddenBy: userId,
        });

        await logAuditEvent({
            userId,
            action: 'update_hotel_cancellation_override',
            entity: 'proposal_hotel',
            entityId: hotelId,
            details: {
                proposalId,
                previousOverride: (hotel as any).cancelDeadlineOverride ?? null,
                newOverride: newOverride ? newOverride.toISOString() : null,
                supplierDeadline: (hotel as any).cancelDeadline ?? null,
            },
            ipAddress: ip,
        });

        return result;
    }

    /**
     * Set or clear the customer payment deadline on a proposal. Pass
     * `paymentDeadline: null` to clear, which leaves the proposal in the
     * "unsendable" state (Send Offer flow refuses until the date is set
     * again).
     *
     * Guard rules:
     *  1. The proposal must exist.
     *  2. The proposal must be modifiable (not sent / approved / declined)
     *     and not locked by another user.
     *  3. Date must not be in the past.
     *  4. **Date must be earlier than the earliest effective cancellation
     *     deadline across all hotels on the proposal.** Customer must pay
     *     before any hotel's cancellation window closes — otherwise SETT
     *     is on the hook for the supplier penalty when the customer
     *     doesn't pay in time and a hotel's free-cxl window has already
     *     elapsed.
     *
     * Audit-logged with both old and new values so disputes are traceable.
     */
    async updatePaymentDeadline(
        proposalId: string,
        params: { paymentDeadline: string | null },
        userId?: string,
        ip?: string,
    ) {
        const existing = await proposalRepository.findById(proposalId);
        if (!existing) {
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        }
        assertModifiable(existing);
        assertNotLocked(existing, userId);
        this.claimForRequest(existing.requestId, userId, ip);

        if (!userId) {
            throw {
                status: 401,
                message: 'Authenticated user required to set payment deadline',
                code: 'UNAUTHORIZED',
            };
        }

        const newDeadline = params.paymentDeadline
            ? new Date(params.paymentDeadline)
            : null;

        if (newDeadline !== null) {
            // Guard 3: not in the past.
            const today = new Date();
            today.setUTCHours(0, 0, 0, 0);
            if (newDeadline.getTime() < today.getTime()) {
                throw {
                    status: 400,
                    message: 'Payment deadline cannot be in the past.',
                    code: 'PAYMENT_DEADLINE_IN_PAST',
                };
            }

            // Guard 4: must be earlier than earliest effective cancellation
            // deadline. Use the override when present, otherwise the
            // supplier's date — same semantics as effectiveCancelDeadline
            // used elsewhere in this service.
            const hotels = (existing.hotels ?? []) as any[];
            let earliestCxl: Date | null = null;
            for (const h of hotels) {
                const effective = h.cancelDeadlineOverride ?? h.cancelDeadline;
                if (!effective) continue;
                const d = new Date(effective);
                if (!earliestCxl || d < earliestCxl) earliestCxl = d;
            }

            if (earliestCxl && newDeadline.getTime() >= earliestCxl.getTime()) {
                throw {
                    status: 400,
                    message:
                        'Payment deadline must be earlier than the earliest cancellation deadline (' +
                        earliestCxl.toISOString().slice(0, 10) +
                        '). The customer must pay before any hotel\'s cancellation window closes — otherwise SETT is exposed to the supplier penalty if payment is late.',
                    code: 'PAYMENT_DEADLINE_AFTER_CANCELLATION',
                    earliestCancellationDeadline: earliestCxl.toISOString(),
                };
            }
        }

        const result = await proposalRepository.updatePaymentDeadline(proposalId, {
            paymentDeadline: newDeadline,
            setBy: userId,
        });

        await logAuditEvent({
            userId,
            action: 'update_proposal_payment_deadline',
            entity: 'proposal',
            entityId: proposalId,
            details: {
                previousDeadline: (existing as any).paymentDeadline ?? null,
                newDeadline: newDeadline ? newDeadline.toISOString() : null,
            },
            ipAddress: ip,
        });

        return result;
    }

    async adjustHotelPricing(proposalId: string, hotelId: string, data: any, userId?: string) {
        const existing = await proposalRepository.findById(proposalId);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        assertModifiable(existing);
        assertNotLocked(existing, userId);

        const result = await proposalRepository.adjustHotelPricing(proposalId, hotelId, data);

        await logAuditEvent({
            userId,
            action: 'adjust_hotel_pricing',
            entity: 'proposal_hotel',
            entityId: hotelId,
            details: { proposalId, changes: data },
        });

        return result;
    }

    async toggleHotelIncluded(
        proposalId: string,
        hotelId: string,
        includedInTotal: boolean,
        userId?: string,
        ip?: string,
    ) {
        const existing = await proposalRepository.findById(proposalId);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        // Selection-only guard: allowed on draft AND sent (so staff can pick the client's
        // final choice after the initial offer was sent)
        assertSelectionEditable(existing);
        assertNotLocked(existing, userId);

        // Verify the hotel actually belongs to this proposal and isn't deleted
        const hotel = existing.hotels.find((h: any) => h.id === hotelId);
        if (!hotel) {
            throw { status: 404, message: 'Hotel not found on this proposal', code: 'NOT_FOUND' };
        }

        const result = await proposalRepository.toggleHotelIncluded(proposalId, hotelId, includedInTotal);

        await logAuditEvent({
            userId,
            action: 'toggle_hotel_included',
            entity: 'proposal_hotel',
            entityId: hotelId,
            details: { proposalId, includedInTotal },
            ipAddress: ip,
        });

        return result;
    }

    async addServiceToProposal(id: string, serviceData: any, userId?: string, ip?: string) {
        const existing = await proposalRepository.findById(id);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        assertModifiable(existing);
        assertNotLocked(existing, userId);
        this.claimForRequest(existing.requestId, userId, ip);

        const result = await proposalRepository.addServiceTx(
            id,
            serviceData,
            (existing.markupSettings as any) ?? undefined,
        );

        await logAuditEvent({
            userId,
            action: 'add_service',
            entity: 'proposal_service',
            entityId: result.service.id,
            details: { proposalId: id, serviceName: serviceData.serviceName },
            ipAddress: ip,
        });

        return result;
    }

    async updateServiceInProposal(proposalId: string, serviceId: string, serviceData: any, userId?: string, ip?: string) {
        const existing = await proposalRepository.findById(proposalId);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };

        // If the ONLY field being updated is `includedInTotal`, use the lenient selection guard
        // (allows toggling after send, so staff can drop/re-include services for the final offer).
        // Any other change (price, quantity, name, etc.) still requires draft status.
        const keys = Object.keys(serviceData ?? {});
        const selectionOnly = keys.length === 1 && keys[0] === 'includedInTotal';
        if (selectionOnly) {
            assertSelectionEditable(existing);
        } else {
            assertModifiable(existing);
        }
        assertNotLocked(existing, userId);

        const result = await proposalRepository.updateServiceTx(proposalId, serviceId, serviceData);
        if (!result) throw { status: 404, message: 'Service not found on this proposal', code: 'NOT_FOUND' };

        await logAuditEvent({
            userId,
            action: 'update_service',
            entity: 'proposal_service',
            entityId: serviceId,
            details: { proposalId, fields: Object.keys(serviceData) },
            ipAddress: ip,
        });

        return result;
    }

    async removeServiceFromProposal(proposalId: string, serviceId: string, userId?: string, ip?: string) {
        const existing = await proposalRepository.findById(proposalId);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        assertModifiable(existing);
        assertNotLocked(existing, userId);
        this.claimForRequest(existing.requestId, userId, ip);

        const service = existing.services.find((s: any) => s.id === serviceId);
        if (!service) throw { status: 404, message: 'Service not found on this proposal', code: 'NOT_FOUND' };

        const result = await proposalRepository.removeServiceTx(proposalId, serviceId);
        if (!result) throw { status: 404, message: 'Service not found on this proposal', code: 'NOT_FOUND' };

        await logAuditEvent({
            userId,
            action: 'remove_service',
            entity: 'proposal_service',
            entityId: serviceId,
            details: { proposalId, snapshot: service },
            ipAddress: ip,
        });

        return result;
    }

    async lockProposal(id: string, userId: string, ip?: string) {
        const existing = await proposalRepository.findById(id);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };

        const locked = await proposalRepository.acquireLock(id, userId);
        if (!locked) {
            // Lock held by someone else — fetch current lock owner info
            throw {
                status: 409,
                message: 'Proposal is currently locked by another user',
                code: 'PROPOSAL_LOCKED',
                owner: { id: existing.lockedBy, lockedAt: existing.lockedAt },
            };
        }

        await logAuditEvent({ userId, action: 'lock_proposal', entity: 'proposal', entityId: id, ipAddress: ip });
        return locked;
    }

    async unlockProposal(id: string, userId: string) {
        const existing = await proposalRepository.findById(id);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };

        await proposalRepository.releaseLock(id, userId);
        await logAuditEvent({ userId, action: 'unlock_proposal', entity: 'proposal', entityId: id });

        return proposalRepository.findById(id);
    }

    async saveDraft(id: string, userId?: string) {
        const existing = await proposalRepository.findById(id);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };

        await proposalRepository.setDraft(id);
        await logAuditEvent({ userId, action: 'save_draft', entity: 'proposal', entityId: id });

        return proposalRepository.findById(id);
    }

    async sendProposal(
        id: string,
        data: { sendToEmail?: string; sendToEmails?: string[]; language?: PdfLanguage },
        userId: string,
        ip?: string,
    ) {
        const existing = await proposalRepository.findById(id);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        this.claimForRequest(existing.requestId, userId, ip);

        // Re-sending a `sent` proposal is now allowed — the second send becomes
        // the final offer (after the client picks a hotel). The backend auto-detects
        // type via offerNumber count.
        if (existing.status === ProposalStatus.declined) {
            throw { status: 409, message: 'Cannot send a declined proposal', code: 'PROPOSAL_NOT_MODIFIABLE' };
        }

        // Resolve recipients — sendToEmails (array) > sendToEmail (single) > booking request contact email
        const request = existing.bookingRequest as any;

        // ── Odoo CRM gate ───────────────────────────────────────────────
        // Oliver's directive: no offer goes out for a request that isn't
        // linked to a real Odoo customer. Pre-cutover requests are
        // grandfathered (compared against ODOO_GATE_ACTIVE_SINCE) so we
        // don't break the existing backlog.
        const requestCreatedAt = request?.createdAt ? new Date(request.createdAt) : null;
        const gateActiveSince = new Date(config.odoo.gateActiveSince);
        if (
            requestCreatedAt &&
            requestCreatedAt >= gateActiveSince &&
            !request?.odooContactId
        ) {
            await logAuditEvent({
                userId,
                action: 'send_proposal_blocked',
                entity: 'proposal',
                entityId: id,
                details: { reason: 'ODOO_CONTACT_REQUIRED', requestId: existing.requestId },
                ipAddress: ip,
            });
            throw {
                status: 400,
                message:
                    'This request must be linked to an Odoo company before the offer can be sent. Open the request, search the company in the Client field, and save.',
                code: 'ODOO_CONTACT_REQUIRED',
            };
        }

        // ── Payment-deadline gate ───────────────────────────────────────
        // The customer-facing PDF + email both display "Payment due by
        // <date>" — that date is staff-set on the proposal. Refuse to
        // send when it's null so the customer never receives an offer
        // without a payment deadline. Pre-cutover proposals (created
        // before the field shipped) fall back to checkoutDate − 30 days
        // in the PDF renderer; we only block sending when the proposal
        // was created on/after the cutover date.
        const proposalCreatedAt = (existing as any).createdAt
            ? new Date((existing as any).createdAt)
            : null;
        const paymentGateCutoff = new Date('2026-06-26T00:00:00Z');
        if (
            !(existing as any).paymentDeadline &&
            proposalCreatedAt &&
            proposalCreatedAt >= paymentGateCutoff
        ) {
            await logAuditEvent({
                userId,
                action: 'send_proposal_blocked',
                entity: 'proposal',
                entityId: id,
                details: { reason: 'PAYMENT_DEADLINE_REQUIRED' },
                ipAddress: ip,
            });
            throw {
                status: 400,
                message:
                    'Set a payment deadline on this proposal before sending. The customer-facing PDF and email both display "Payment due by <date>" and cannot be sent without it.',
                code: 'PAYMENT_DEADLINE_REQUIRED',
            };
        }

        let recipients: string[] = [];
        if (data.sendToEmails && data.sendToEmails.length > 0) {
            recipients = data.sendToEmails;
        } else if (data.sendToEmail) {
            recipients = [data.sendToEmail];
        } else if (request?.contactEmail) {
            recipients = [request.contactEmail];
        }
        // Deduplicate and normalize
        recipients = Array.from(new Set(recipients.map((e) => e.trim().toLowerCase()).filter(Boolean)));

        if (recipients.length === 0) {
            throw {
                status: 400,
                message: 'No recipient email — provide sendToEmail/sendToEmails or set contactEmail on the booking request.',
                code: 'NO_RECIPIENT_EMAIL',
            };
        }

        const recipientEmail = recipients.join(', ');

        // Generate the PDF (re-use the same flow as approve/preview).
        // Honour the staff-picked `language` so the PDF + email body match
        // the customer's preferred language. Default to English.
        const sendLanguage: PdfLanguage = data.language ?? 'en';
        let pdfBuffer: Buffer;
        let pdfData: OfferPdfData;
        try {
            pdfData = await this.buildPdfData(existing, sendLanguage);
            pdfBuffer = await generateOfferPdf(pdfData);
        } catch (err: any) {
            logger.error({ err, proposalId: id }, 'sendProposal: PDF generation failed');
            throw {
                status: 500,
                message: 'Failed to generate the offer PDF — cannot send email.',
                code: 'PDF_GENERATION_FAILED',
            };
        }

        // Determine offer type based on send history:
        //   0 prior sends → "initial"
        //   1 prior send  → "final"
        //   2+ prior sends → "revision"
        const offerCount = await proposalRepository.countOffers(id);
        const offerNumber = offerCount + 1;
        const offerType =
            offerCount === 0 ? 'initial' :
            offerCount === 1 ? 'final' :
            'revision';

        // Upload the PDF to S3 (if configured) BEFORE attempting the email send.
        // This way we have a stored artifact even if the email fails — and we can
        // clean up orphans later if needed.
        let pdfKey = '';
        let pdfUrl = '';
        try {
            if (config.s3.endpoint && config.s3.accessKeyId) {
                const filename = `offer-${offerNumber}-${offerType}-${Date.now()}`;
                pdfUrl = await storageService.uploadPdf(id, filename, pdfBuffer);
                // Rebuild the S3 key (uploadPdf uses this pattern internally)
                pdfKey = `proposals/${id}/${filename}.pdf`;
            } else {
                // Fallback: data URI for local dev without S3
                pdfUrl = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;
                pdfKey = `data-uri-offer-${offerNumber}`;
                logger.warn({ proposalId: id }, 'S3 not configured — offer PDF stored as data URI');
            }
        } catch (err: any) {
            logger.error({ err, proposalId: id }, 'sendProposal: PDF upload to S3 failed — will still attempt to send email');
        }

        // Attempt to send the email — Phase 1: Brevo SMTP only (Gmail-OAuth path removed).
        // Customer-facing email; Reply-To is the group inbox per Read B rule.
        const refNum = request?.referenceNumber ?? 0;
        const contactName = request?.contactName ?? request?.firstName ?? 'Guest';
        const destinationName = request?.destinationName ?? 'Unknown';

        // notification.sendOfferPdfToAgent does NOT throw for normal failures — it returns
        // a discriminated union (EmailSendResult). Inspect ok/failure to decide what to do.
        const sendResult = await notificationService.sendOfferPdfToAgent({
            agentEmail: recipientEmail,
            referenceNumber: refNum,
            contactName,
            destinationName,
            pdfBuffer,
            userId,
            requestId: existing.requestId ?? undefined,
            proposalId: id,
            language: sendLanguage,
            paymentDeadline: (existing as any).paymentDeadline
                ? new Date((existing as any).paymentDeadline).toISOString()
                : null,
        });

        // CRITICAL: only mark proposal as 'sent' if the email actually went through.
        // Otherwise the status stays unchanged so the user can retry.
        if (!sendResult.ok) {
            await logAuditEvent({
                userId,
                action: 'send_proposal_failed',
                entity: 'proposal',
                entityId: id,
                details: {
                    sentToEmail: recipientEmail,
                    sentToEmails: recipients,
                    emailError: sendResult.failure.message,
                    emailErrorCode: sendResult.failure.code,
                    emailErrorDetail: sendResult.failure.detail,
                    method: sendResult.method,
                },
                ipAddress: ip,
            });

            // Throw a structured error so the controller can map it to the right HTTP
            // status code and surface the failure.code to the frontend.
            throw {
                status: sendResult.failure.httpStatus,
                code: 'EMAIL_SEND_FAILED',
                message: sendResult.failure.message,
                failure: {
                    code: sendResult.failure.code,
                    message: sendResult.failure.message,
                    retryable: sendResult.failure.retryable,
                    userActionRequired: sendResult.failure.userActionRequired,
                    method: sendResult.method,
                },
                // Backward-compat shape under data.* so existing frontend reading these
                // fields continues to work.
                data: {
                    sent: false,
                    emailSent: false,
                    emailError: sendResult.failure.message,
                    emailErrorCode: sendResult.failure.code,
                    proposal: existing,
                },
            };
        }

        // Email succeeded — update status, create offer history row, audit log, return success
        const updated = await proposalRepository.setSent(id, userId, recipientEmail);

        if (existing.requestId) {
            await requestRepository.updateStatus(existing.requestId, 'sent' as any);
        }

        // Build hotel & service snapshots so we can later reconstruct what was in each offer
        const activeHotels = (existing.hotels ?? []).filter((h: any) => !h.deletedAt);
        const hotelSnapshot = activeHotels.map((h: any) => ({
            hotelCode: h.hotelCode,
            hotelName: h.hotelName ?? null,
            includedInTotal: h.includedInTotal !== false,
            totalPrice: h.totalPrice ? Number(h.totalPrice) : null,
            currency: h.currency ?? null,
        }));
        const serviceSnapshot = (existing.services ?? []).map((s: any) => ({
            serviceName: s.serviceName,
            includedInTotal: s.includedInTotal !== false,
            sellPrice: s.sellPrice ? Number(s.sellPrice) : null,
            quantity: s.quantity ?? 1,
            days: s.days ?? 1,
            currency: s.currency ?? null,
        }));

        let offerRow = null;
        try {
            offerRow = await proposalRepository.createOffer({
                proposalId: id,
                offerNumber,
                type: offerType,
                pdfKey,
                pdfUrl,
                sentBy: userId,
                sentToEmails: recipients,
                hotelSnapshot,
                serviceSnapshot,
                totalPrice: pdfData.totalPrice ?? null,
                currency: pdfData.currency ?? null,
                method: sendResult.method,
            });
        } catch (err: any) {
            // Don't fail the whole send if history row fails — the email went out successfully.
            logger.error({ err, proposalId: id }, 'sendProposal: failed to create ProposalOffer history row');
        }

        await logAuditEvent({
            userId,
            action: 'send_proposal',
            entity: 'proposal',
            entityId: id,
            details: {
                sentToEmail: recipientEmail,
                sentToEmails: recipients,
                method: sendResult.method,
                offerNumber,
                offerType,
                offerId: offerRow?.id ?? null,
                includedHotels: activeHotels.filter((h: any) => h.includedInTotal !== false).length,
            },
            ipAddress: ip,
        });

        return {
            sent: true,
            emailSent: true,
            emailError: null,
            emailErrorCode: null,
            sentToEmails: recipients,
            proposal: updated,
            offer: offerRow ? {
                id: offerRow.id,
                offerNumber: offerRow.offerNumber,
                type: offerRow.type,
                pdfUrl: offerRow.pdfUrl,
                sentAt: offerRow.sentAt,
            } : null,
        };
    }

    async previewPdf(id: string, language?: PdfLanguage, timezone?: string | null) {
        const existing = await proposalRepository.findById(id);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };

        const lang = language ?? 'en';
        const pdfData = await this.buildPdfData(existing, lang, timezone);
        const pdfBuffer = await generateOfferPdf(pdfData);

        return { pdfBuffer, note: 'Preview PDF generated' };
    }

    /** List all offers sent for a proposal (history). */
    async listOffers(proposalId: string) {
        const proposal = await proposalRepository.findById(proposalId);
        if (!proposal) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };

        const offers = await proposalRepository.listOffers(proposalId);
        return offers.map((o: any) => ({
            id: o.id,
            offerNumber: o.offerNumber,
            type: o.type,
            sentAt: o.sentAt,
            sentBy: o.sentBy,
            sentToEmails: o.sentToEmails,
            totalPrice: o.totalPrice ? Number(o.totalPrice) : null,
            currency: o.currency,
            method: o.method,
            pdfUrl: o.pdfUrl,
            hotelCount: Array.isArray(o.hotelSnapshot)
                ? o.hotelSnapshot.filter((h: any) => h.includedInTotal).length
                : 0,
            serviceCount: Array.isArray(o.serviceSnapshot)
                ? o.serviceSnapshot.filter((s: any) => s.includedInTotal).length
                : 0,
        }));
    }

    /**
     * Download the PDF for a specific offer (by offer id).
     *
     * When `language` is provided, the PDF is re-generated in that
     * language from the current proposal state. When omitted, the
     * original (cached) PDF from the time of sending is returned. See
     * the `downloadPdf` docstring for the snapshot trade-off.
     */
    async downloadOfferPdf(
        proposalId: string,
        offerId: string,
        language?: PdfLanguage,
        timezone?: string | null,
    ): Promise<{ pdfBuffer: Buffer; filename: string }> {
        const offer = await proposalRepository.getOfferById(offerId);
        if (!offer || offer.proposalId !== proposalId) {
            throw { status: 404, message: 'Offer not found', code: 'OFFER_NOT_FOUND' };
        }

        const langSuffix = language ? `-${language}` : '';
        const filename = `offer-${offer.offerNumber}-${offer.type}${langSuffix}.pdf`;

        // ── Re-generate on language request ─────────────────────────────
        if (language) {
            const proposal = await proposalRepository.findById(proposalId);
            if (!proposal) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
            const pdfData = await this.buildPdfData(proposal, language, timezone);
            const pdfBuffer = await generateOfferPdf(pdfData);
            return { pdfBuffer, filename };
        }

        // Legacy base64 data URI (S3 not configured at the time of sending)
        if (offer.pdfUrl.startsWith('data:')) {
            const base64 = offer.pdfUrl.split(',')[1] ?? '';
            return { pdfBuffer: Buffer.from(base64, 'base64'), filename };
        }

        // S3 key — download from object storage
        const pdfBuffer = await storageService.downloadPdf(offer.pdfKey);
        return { pdfBuffer, filename };
    }

    /**
     * Step 4.2 — Approve a proposal.
     *
     * Guards:
     * - Proposal must exist
     * - Status must be pending_admin_approval or draft
     *
     * Generates the PDF, stores it on the proposal, and updates status to `approved`.
     *
     * IMPORTANT: This endpoint does NOT send the email. The actual email send is
     * handled by the subsequent POST /actions/send call. Sending here would result
     * in DUPLICATE emails when the frontend's "Approve and Send" button calls both
     * endpoints in sequence.
     */
    async approveProposal(id: string, data: { agentEmail?: string; adminNotes?: string; language?: PdfLanguage }, userId: string, ip?: string) {
        const existing = await proposalRepository.findById(id);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };

        if (!APPROVABLE_STATUSES.includes(existing.status)) {
            throw {
                status: 409,
                message: `Proposal cannot be approved in status '${existing.status}'. Must be 'pending_admin_approval' or 'draft'.`,
                code: 'PROPOSAL_NOT_APPROVABLE',
            };
        }

        // Generate PDF and upload to S3
        const lang = data.language ?? 'en';
        let pdfBuffer: Buffer | null = null;
        let pdfUrl: string | null = null;
        try {
            const pdfData = await this.buildPdfData(existing, lang);
            pdfBuffer = await generateOfferPdf(pdfData);
            // Store the bare S3 KEY (not a full URL) so downloadPdf() below
            // can pass it directly to storageService.download(key). The
            // legacy 4v8 path that stored the full URL is incompatible with
            // the downstream consumer at line ~1104.
            if (storageService.isConfigured()) {
                const pdfKey = storageService.buildProposalPdfKey(id);
                await storageService.upload(pdfKey, pdfBuffer);
                pdfUrl = pdfKey;
                logger.info({ proposalId: id, pdfKey }, 'PDF uploaded to S3');
            } else {
                // Fallback: store as base64 data URI if S3 not configured (local dev)
                pdfUrl = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;
                logger.warn({ proposalId: id }, 'S3 not configured — PDF stored as base64 in DB');
            }
            console.log(`[Step 4.2] PDF generated for proposal ${id} (${pdfBuffer.length} bytes)`);
        } catch (err: any) {
            logger.error({ err, proposalId: id }, 'Step 4.2: PDF generation failed — approving without PDF');
            console.log(`[Step 4.2] WARNING: PDF generation failed for proposal ${id}: ${err.message}`);
        }

        // Update status to approved
        const updated = await proposalRepository.setApproved(id, userId, pdfUrl ?? undefined);

        const request = existing.bookingRequest;
        const refNum = (request as any)?.referenceNumber ?? 0;
        const contactName = (request as any)?.contactName ?? (request as any)?.firstName ?? 'Guest';
        const destinationName = (request as any)?.destinationName ?? 'Unknown';
        const agentEmail = data.agentEmail ?? (request as any)?.contactEmail;

        // In-app + email notification for staff (Phase 1: approval now triggers an email too)
        try {
            await notificationService.notifyOfferApproved({
                requestId: existing.requestId ?? '',
                proposalId: id,
                referenceNumber: refNum,
                contactName,
                destinationName,
                approvedBy: userId,
                agentEmail,
                staffEmail: resolveStaffNotificationEmail(),
            });
        } catch (err: any) {
            logger.error({ err, proposalId: id }, 'Step 4.2: Failed to send approval notification — proposal is still approved');
            console.log(`[Step 4.2] WARNING: Approval notification failed for proposal ${id}: ${err.message}`);
        }

        try {
            await logAuditEvent({
                userId,
                action: 'approve_proposal',
                entity: 'proposal',
                entityId: id,
                details: { agentEmail, pdfGenerated: !!pdfBuffer, adminNotes: data.adminNotes },
                ipAddress: ip,
            });
        } catch (err: any) {
            logger.error({ err, proposalId: id }, 'Step 4.2: Audit log failed — proposal is still approved');
        }

        console.log(`[Step 4.2] Proposal ${id} APPROVED by ${userId}. PDF=${!!pdfBuffer}`);
        logger.info({ proposalId: id, userId, pdfGenerated: !!pdfBuffer }, 'Step 4.2: Proposal approved');

        // Return shape preserved for backward compatibility:
        //  - emailSent is always false here (the /send endpoint handles email)
        //  - agentEmail still returned so the frontend knows which address /send will target
        return {
            proposal: updated,
            pdfGenerated: !!pdfBuffer,
            emailSent: false,
            agentEmail: agentEmail ?? null,
        };
    }

    /**
     * Decline a proposal.
     *
     * Guards:
     * - Proposal must exist
     * - Status must be pending_admin_approval or draft
     * - Rejection reason is required
     * - Sends in-app + email notification to staff
     */
    async declineProposal(id: string, data: { rejectionReason: string }, userId: string, ip?: string) {
        const existing = await proposalRepository.findById(id);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        this.claimForRequest(existing.requestId, userId, ip);

        if (!DECLINABLE_STATUSES.includes(existing.status)) {
            throw {
                status: 409,
                message: `Proposal cannot be declined in status '${existing.status}'. It is already declined or in a terminal state.`,
                code: 'PROPOSAL_NOT_DECLINABLE',
            };
        }

        if (!data.rejectionReason || data.rejectionReason.trim().length === 0) {
            throw {
                status: 400,
                message: 'Rejection reason is required when declining a proposal.',
                code: 'REJECTION_REASON_REQUIRED',
            };
        }

        const updated = await proposalRepository.setDeclined(id, userId, data.rejectionReason.trim());

        // Update parent booking request status to 'declined' so the requests list
        // reflects the client's decision instead of still showing 'sent'.
        if (existing.requestId) {
            try {
                await requestRepository.updateStatus(existing.requestId, 'declined' as any);
            } catch (err: any) {
                logger.error(
                    { err, requestId: existing.requestId, proposalId: id },
                    'Failed to update parent BookingRequest status to declined — proposal is still declined',
                );
            }
        }

        // Notify staff via in-app + email
        const request = existing.bookingRequest;
        const refNum = (request as any)?.referenceNumber ?? 0;
        const contactName = (request as any)?.contactName ?? (request as any)?.firstName ?? 'Guest';
        const destinationName = (request as any)?.destinationName ?? 'Unknown';

        try {
            await notificationService.notifyOfferDeclined({
                requestId: existing.requestId ?? '',
                proposalId: id,
                referenceNumber: refNum,
                contactName,
                destinationName,
                rejectedBy: userId,
                rejectionReason: data.rejectionReason.trim(),
                staffEmail: resolveStaffNotificationEmail(),
            });
        } catch (err: any) {
            logger.error({ err, proposalId: id }, 'Step 4.2: Failed to send decline notification — proposal is still declined');
        }

        // Phase 1: also notify the external contact that their offer was declined.
        const contactEmail = (request as any)?.contactEmail;
        if (contactEmail) {
            try {
                await notificationService.notifyOfferDeclinedContact({
                    requestId: existing.requestId ?? '',
                    proposalId: id,
                    referenceNumber: refNum,
                    contactEmail,
                    contactName,
                    destinationName,
                    rejectionReason: data.rejectionReason.trim(),
                });
            } catch (err: any) {
                logger.error({ err, proposalId: id }, 'Step 4.2: Failed to send decline notice to contact');
            }
        }

        try {
            await logAuditEvent({
                userId,
                action: 'decline_proposal',
                entity: 'proposal',
                entityId: id,
                details: { rejectionReason: data.rejectionReason },
                ipAddress: ip,
            });
        } catch (err: any) {
            logger.error({ err, proposalId: id }, 'Step 4.2: Audit log failed — proposal is still declined');
        }

        console.log(`[Step 4.2] Proposal ${id} DECLINED by ${userId}. Reason: ${data.rejectionReason}`);
        logger.info({ proposalId: id, userId, rejectionReason: data.rejectionReason }, 'Step 4.2: Proposal declined');

        return { proposal: updated };
    }

    /**
     * Build PDF data from a proposal + its booking request.
     */
    private async buildPdfData(
        proposal: any,
        language: PdfLanguage = 'en',
        timezone?: string | null,
    ): Promise<OfferPdfData> {
        const request = proposal.bookingRequest;

        // ── Company details from settings ────────────────────────────────
        let companyDetails: Record<string, string> = {};
        try {
            companyDetails = await settingsService.getCompanyDetails() as Record<string, string>;
        } catch {
            logger.warn('buildPdfData: Could not fetch company details from settings');
        }

        // ── Client & trip info from booking request ─────────────────────
        const refNum = (request as any)?.referenceNumber ?? 0;
        const contactName = (request as any)?.contactName ?? (request as any)?.firstName ?? 'Guest';
        const companyNameClient = (request as any)?.companyName ?? '';
        const contactEmail = (request as any)?.contactEmail ?? '';
        const contactPhone = (request as any)?.contactPhone ?? '';
        const contactPhoneCountryCode = (request as any)?.contactPhoneCountryCode ?? null;
        const destinationName = (request as any)?.destinationName ?? 'Unknown';
        const checkinDate = (request as any)?.checkinDate
            ? new Date((request as any).checkinDate).toISOString().split('T')[0]
            : '';
        const checkoutDate = (request as any)?.checkoutDate
            ? new Date((request as any).checkoutDate).toISOString().split('T')[0]
            : '';
        const nights = (request as any)?.nights ?? 1;
        const totalRooms = countTotalRooms((request as any)?.rooms);
        // Guest count for the Trip Details "GUESTS" cell. Sourced from
        // BookingRequest.groupSize — captured on the Step 1 Trip Details
        // form. Falls back to null on legacy requests that pre-date the
        // field; the PDF template renders "—" in that case.
        const groupSize = typeof (request as any)?.groupSize === 'number'
            ? (request as any).groupSize
            : null;
        const mealPlan = (request as any)?.breakfastPreference ?? 'RO';
        let specialRequirements = (request as any)?.specialRequirements ?? null;
        let customerNotes = (request as any)?.customerNotes ?? null;
        const cancellationConditions = (request as any)?.cancellationConditions ?? null;
        const termsAndConditions = (request as any)?.termsAndConditions ?? null;

        // ── Hotels ───────────────────────────────────────────────────────
        // Show only non-deleted hotels that are marked for inclusion in the total.
        // Excluded hotels (Oliver's "options") don't appear in the customer-facing PDF.
        const activeHotels = (proposal.hotels ?? []).filter(
            (h: any) => !h.deletedAt && h.includedInTotal !== false,
        );
        let sellingPrice = 0;
        let currency = 'EUR';
        let totalPrice = 0;

        for (const h of activeHotels) {
            const rooms = h.rooms as any;
            if (rooms?.standard?.sell && sellingPrice === 0) {
                sellingPrice = rooms.standard.sell;
            }
            totalPrice += Number(h.totalPrice ?? 0);
            if (h.currency) currency = h.currency;
        }

        // Pre-fetch hotel thumbnails in parallel — one DB query for the
        // image-key set + parallel WBE CDN fetches. Inlined as data URIs
        // so the emailed PDF stays self-contained (no network at viewer
        // time). Failures are absorbed per-hotel; a missing image just
        // means the hotel block renders without a thumbnail.
        // ── Hotel enrichment ────────────────────────────────────────────
        // Run image, description, and facilities lookups in parallel so the
        // whole PDF-data pipeline is bounded by the slowest of the three
        // batches (typically the image fetcher, since it hits WBE/GIATA
        // over the network). Per-source failures are absorbed inside the
        // helpers — the PDF still renders if any one of them comes back
        // empty.
        const hotelCodes = activeHotels.map((h: any) => h.hotelCode).filter(Boolean);
        const [hotelImagesByCode, hotelEnrichmentByCode] = await Promise.all([
            resolveHotelImagesForPdf(hotelCodes),
            resolveHotelEnrichmentForPdf(hotelCodes, language as PdfLanguageCode),
        ]);

        // Map hotel entries — each ProposalHotel has a rooms JSON with one or more room type keys
        // e.g. { single: {...}, twin: {...}, standardDoubleBeds: { qty: 6, sell: 348, net: 332.77, nights: 1 } }
        // We emit ONE OfferHotel row per room-type key with qty > 0; the PDF
        // renderer groups them back into a single hotel card via hotelName,
        // so a 4-room-type hotel renders as one card with 4 table rows.
        // Previously this code picked a single key and dropped the rest —
        // the QA Group AI Tool Report 1b §6b bug.
        const hotels = activeHotels.flatMap((h: any) => {
            const hRooms = h.rooms as any ?? {};
            const enrichment = hotelEnrichmentByCode.get(h.hotelCode) ?? { description: null, facilities: [] };

            // Filter to entries that look like a real room-type row: nested
            // object shape with `qty` defined. Plain-number top-level keys
            // (legacy BookingRequest.rooms shape) are ignored — those never
            // appear on a ProposalHotel.rooms.
            const typedEntries = Object.entries(hRooms).filter(([, v]: [string, any]) =>
                v !== null && typeof v === 'object' && typeof v.qty === 'number',
            );

            // Sort to a stable, customer-friendly order: bigger rooms first
            // because Standard Doubles are usually the bulk of a group's
            // booking. Falls back to insertion order via toLowerCase string.
            const ORDER = ['single', 'twin', 'twinBeds', 'double', 'standardDoubleBeds', 'triple', 'quadruple', 'quadruple__sub_double', 'suite', 'suites', 'standard'];
            typedEntries.sort(([a], [b]) => {
                const ai = ORDER.indexOf(a);
                const bi = ORDER.indexOf(b);
                if (ai !== -1 && bi !== -1) return ai - bi;
                if (ai !== -1) return -1;
                if (bi !== -1) return 1;
                return a.localeCompare(b);
            });

            // Skip hotels with no usable room data so we don't emit an
            // empty card with just the image and header.
            if (typedEntries.length === 0) return [];

            // Shared per-hotel facts — repeated across every emitted row so
            // the PDF can render them once at the hotel-card header level
            // and once per table row. The renderer reads them from rows[0].
            const sharedFields = {
                hotelName: h.hotelName ?? h.hotelCode ?? 'Unknown Hotel',
                starRating: typeof h.starRating === 'number' ? h.starRating : (h.starRating ? Number(h.starRating) : null),
                address: h.address ?? null,
                addressCity: h.addressCity ?? null,
                addressCountry: h.addressCountry ?? null,
                mealPlan,
                totalPrice: Number(h.totalPrice ?? 0),
                cancelDeadline: (() => {
                    const effective = h.cancelDeadlineOverride ?? h.cancelDeadline;
                    return effective ? new Date(effective).toISOString() : null;
                })(),
                freeCancellation: typeof h.freeCancellation === 'boolean' ? h.freeCancellation : null,
                hotelRef: (h as any).hotelRef ?? null,
                // SETTHub hotel-detail URL — makes the hotel name clickable
                // in the PDF, opening the hotel page (same link the FE Add
                // Hotel card uses). Null for legacy rows; PDF renders plain
                // text in that case.
                sethubDetailsUrl: (h as any).sethubDetailsUrl ?? null,
                // Pre-fetched thumbnail inlined as a data URI. Null when
                // WBE has no image for the hotelCode — the PDF renders
                // the hotel block without the thumbnail column in that case.
                hotelImageDataUri: hotelImagesByCode.get(h.hotelCode) ?? null,
                // Resolved from GIATA (preferred) → master.Hotel.metadata
                // fallback. Language-aware via the `language` param above.
                description: enrichment.description,
                // Brand-prioritised facility-name list, capped at 8.
                facilities: enrichment.facilities,
            };

            // Emit one OfferHotel row per room-type. The PDF renderer groups
            // by hotelName so all rows for one hotel collapse into one card.
            return typedEntries.map(([roomType, data]: [string, any]) => ({
                ...sharedFields,
                roomType,
                roomQty: data.qty ?? 0,
                nights: typeof data.nights === 'number' && data.nights > 0
                    ? data.nights
                    : nights,
                pricePerRoomPerNight: data.sell ?? sellingPrice,
            }));
        });

        // ── Services ─────────────────────────────────────────────────────
        // Show only services marked for inclusion in the total (Oliver's "options" feature).
        const services = (proposal.services ?? [])
            .filter((s: any) => s.includedInTotal !== false)
            .map((s: any) => ({
                serviceName: s.serviceName ?? 'Service',
                quantity: s.quantity ?? 1,
                days: s.days ?? 1,
                unitPrice: Number(s.sellPrice ?? 0),
                totalPrice: Number(s.sellPrice ?? 0) * (s.quantity ?? 1) * (s.days ?? 1),
            }));

        // ── Terms & Cancellation: live settings, snapshot fallback ──────
        // Source precedence (per Neha + FE alignment 2026-06-02,
        // `policies-rich-text-handover.md` §8):
        //   1. /settings/policies in the requested language (live admin edit)
        //   2. /settings/policies in the OTHER language (when only one
        //      translation exists)
        //   3. The per-request BookingRequest snapshot
        //      (`termsAndConditions` / `cancellationConditions`) for legacy
        //      requests created before settings was populated
        //
        // This matches the FE preview pixel-for-pixel: what staff see in
        // ContractPreviewModal is what gets sent. Trade-off: editing
        // /settings/policies AFTER an offer was sent will change what a
        // re-download shows. Acceptable per product decision; the snapshot
        // exists only to keep the old data path working.
        let finalTerms: string | null = null;
        let finalCxl: string | null = null;

        try {
            const policies = await settingsService.getPolicies() as Record<string, string>;
            if (language === 'de') {
                finalTerms = policies?.termsConditionsDe || policies?.termsConditionsEn || null;
                finalCxl  = policies?.cancellationConditionsDe || policies?.cancellationConditionsEn || null;
            } else {
                finalTerms = policies?.termsConditionsEn || policies?.termsConditionsDe || null;
                finalCxl  = policies?.cancellationConditionsEn || policies?.cancellationConditionsDe || null;
            }
        } catch (err) {
            logger.warn({ err, language }, 'Failed to load /settings/policies — falling back to per-request snapshot');
            finalTerms = null;
            finalCxl = null;
        }

        // Legacy snapshot fallback — only used when settings is empty for
        // both languages, OR when the settings call errored. The snapshot is
        // language-agnostic (pre-bilingual data); we use it as-is regardless
        // of the requested PDF language.
        if (!finalTerms && termsAndConditions) finalTerms = termsAndConditions;
        if (!finalCxl && cancellationConditions) finalCxl = cancellationConditions;

        // ── Translate dynamic user-entered text if target language ≠ source ─
        // Source is assumed English (staff/webhook input). Only translate when
        // the PDF language is German and the text is originally in English.
        if (language !== 'en') {
            const dynamicTexts = [specialRequirements, customerNotes];
            const serviceNames = services.map((s: any) => s.serviceName as string | null);

            try {
                const translated = await translateBatch(
                    [...dynamicTexts, ...serviceNames],
                    language,
                    'en',
                );

                // Re-assign translated values
                specialRequirements = translated[0] || specialRequirements;
                customerNotes = translated[1] || customerNotes;

                // Update service names with translations
                for (let si = 0; si < services.length; si++) {
                    services[si].serviceName = translated[2 + si] || services[si].serviceName;
                }
            } catch (err: any) {
                logger.warn({ err, language }, 'Dynamic text translation failed — using original text');
            }
        }

        return {
            // Company
            companyName: companyDetails.companyName ?? 'S & T T WORLDWIDE RESERVATION FZE',
            companyAddress: companyDetails.address ?? '',
            companyPhone: companyDetails.phoneNumber ?? '',
            companyPhoneCountryCode: (companyDetails as any).phoneCountryCode ?? null,
            companyEmail: companyDetails.emailAddress ?? '',
            companyWebsite: companyDetails.website ?? '',
            companyTaxId: companyDetails.taxId ?? '',
            assignedPerson: companyDetails.assignedPerson ?? '',

            // Client
            referenceNumber: refNum,
            contactName,
            companyNameClient,
            contactEmail,
            contactPhone,
            contactPhoneCountryCode,

            // Trip
            destinationName,
            checkinDate,
            checkoutDate,
            nights,
            groupSize,

            // Hotels
            hotels,

            // Services
            services,

            // Notes & Policies
            specialRequirements,
            customerNotes,
            cancellationConditions: finalCxl,
            termsAndConditions: finalTerms,
            paymentDeadline: (proposal as any).paymentDeadline
                ? new Date((proposal as any).paymentDeadline).toISOString()
                : null,

            // Totals
            currency,
            totalPrice,
            sellingPricePerRoomPerNight: sellingPrice,
            totalRooms,

            // Language
            language,

            // Viewer timezone — keeps the cancel-deadline badge in the PDF in
            // sync with the on-screen Offer Preview (see OfferPdfData.timezone).
            timezone: timezone ?? null,

            // Document date — the proposal's creation date, so the PDF header
            // shows the SAME date as the on-screen Offer Preview (and stays
            // stable on re-download) instead of the render date.
            documentDate: proposal?.createdAt
                ? new Date(proposal.createdAt).toISOString()
                : null,
        };
    }

    async updateProposalStatus(id: string, status: string) {
        return proposalRepository.update(id, { status });
    }

    /**
     * Download the PDF for a proposal.
     *
     * When `language` is provided, the PDF is **re-generated** in that
     * language from the current proposal state (the cached S3 blob is
     * ignored). When `language` is omitted, the cached blob is served as
     * before. This keeps the EN/DE bilingual feature working without
     * having to maintain per-language S3 keys: callers ask for what they
     * want at download time and we render on demand.
     */
    async downloadPdf(
        id: string,
        language?: PdfLanguage,
        timezone?: string | null,
    ): Promise<{ pdfBuffer: Buffer; filename: string }> {
        const existing = await proposalRepository.findById(id);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };

        // ── Re-generate on language request ─────────────────────────────
        // Build PdfData from the live proposal state and render fresh.
        // Note: this reads CURRENT proposal data, not a frozen snapshot.
        // If the proposal was edited after send, the re-rendered PDF
        // reflects those edits. Documented in the plan as a known
        // trade-off (a snapshot-aware re-render would need a follow-up).
        if (language) {
            const pdfData = await this.buildPdfData(existing, language, timezone);
            const pdfBuffer = await generateOfferPdf(pdfData);
            return { pdfBuffer, filename: `offer-${id}-${language}.pdf` };
        }

        if (!existing.pdfUrl) {
            throw { status: 404, message: 'No PDF available for this proposal', code: 'PDF_NOT_FOUND' };
        }

        // Legacy base64 data URI (backward compatibility)
        if (existing.pdfUrl.startsWith('data:')) {
            const base64Data = existing.pdfUrl.split(',')[1];
            return {
                pdfBuffer: Buffer.from(base64Data, 'base64'),
                filename: `offer-${id}.pdf`,
            };
        }

        // S3 key — download from object storage
        const pdfBuffer = await storageService.download(existing.pdfUrl);
        return { pdfBuffer, filename: `offer-${id}.pdf` };
    }
}

export default new ProposalService();

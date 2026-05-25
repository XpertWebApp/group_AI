import proposalRepository from '../repositories/proposal.repository';
import notificationService from './notification.service';
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

    async getProposalById(id: string) {
        const proposal = await proposalRepository.findById(id);
        if (!proposal) {
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        }
        return proposal;
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

    async sendProposal(id: string, data: { sendToEmail?: string; sendToEmails?: string[] }, userId: string, ip?: string) {
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

        // Generate the PDF (re-use the same flow as approve/preview)
        let pdfBuffer: Buffer;
        let pdfData: OfferPdfData;
        try {
            pdfData = await this.buildPdfData(existing);
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

    async previewPdf(id: string) {
        const existing = await proposalRepository.findById(id);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };

        // Generate a preview PDF buffer (same as approval PDF but not persisted)
        const pdfData = await this.buildPdfData(existing);
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

    /** Download the PDF for a specific offer (by offer id). */
    async downloadOfferPdf(
        proposalId: string,
        offerId: string,
    ): Promise<{ pdfBuffer: Buffer; filename: string }> {
        const offer = await proposalRepository.getOfferById(offerId);
        if (!offer || offer.proposalId !== proposalId) {
            throw { status: 404, message: 'Offer not found', code: 'OFFER_NOT_FOUND' };
        }

        const filename = `offer-${offer.offerNumber}-${offer.type}.pdf`;

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
    async approveProposal(id: string, data: { agentEmail?: string; adminNotes?: string }, userId: string, ip?: string) {
        const existing = await proposalRepository.findById(id);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };

        if (!APPROVABLE_STATUSES.includes(existing.status)) {
            throw {
                status: 409,
                message: `Proposal cannot be approved in status '${existing.status}'. Must be 'pending_admin_approval' or 'draft'.`,
                code: 'PROPOSAL_NOT_APPROVABLE',
            };
        }

        // Generate PDF
        let pdfBuffer: Buffer | null = null;
        let pdfUrl: string | null = null;
        try {
            const pdfData = await this.buildPdfData(existing);
            pdfBuffer = await generateOfferPdf(pdfData);
            // Upload to S3 if configured, otherwise fall back to data URI (local dev)
            if (config.s3.endpoint && config.s3.accessKeyId) {
                const filename = `offer-${Date.now()}`;
                pdfUrl = await storageService.uploadPdf(id, filename, pdfBuffer);
            } else {
                pdfUrl = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;
                logger.warn({ proposalId: id }, 'S3 not configured — storing PDF as data URI');
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
                staffEmail: process.env.STAFF_NOTIFICATION_EMAIL,
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
                staffEmail: process.env.STAFF_NOTIFICATION_EMAIL,
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
    private async buildPdfData(proposal: any): Promise<OfferPdfData> {
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
        const mealPlan = (request as any)?.breakfastPreference ?? 'RO';
        const specialRequirements = (request as any)?.specialRequirements ?? null;
        const customerNotes = (request as any)?.customerNotes ?? null;
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

        // Map hotel entries — each ProposalHotel has a rooms JSON with one or more room type keys
        // e.g. { double: { qty: 20, sell: 178, net: 155, nights: 3 } }
        // or legacy: { standard: { qty: 30, sell: 178, net: 155, nights: 3 } }
        const hotels = activeHotels.map((h: any) => {
            const hRooms = h.rooms as any ?? {};
            // Find the room type key — first non-standard key, or 'standard', or fallback to 'double'
            const roomTypeKeys = Object.keys(hRooms);
            const roomType = roomTypeKeys.find((k) => k !== 'standard') ?? roomTypeKeys[0] ?? 'double';
            const roomData = hRooms[roomType] ?? {};
            const qty = roomData.qty ?? 0;
            const sell = roomData.sell ?? sellingPrice;

            return {
                hotelName: h.hotelName ?? h.hotelCode ?? 'Unknown Hotel',
                starRating: null as number | null,
                addressCity: null as string | null,
                addressCountry: null as string | null,
                roomType,
                roomQty: qty,
                mealPlan,
                pricePerRoomPerNight: sell,
                totalPrice: Number(h.totalPrice ?? 0),
                cancelDeadline: h.cancelDeadline ? new Date(h.cancelDeadline).toISOString() : null,
            };
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

        // ── Fallback terms from settings if not on the request ───────────
        let finalTerms = termsAndConditions;
        if (!finalTerms) {
            try {
                const policies = await settingsService.getPolicies() as Record<string, string>;
                finalTerms = policies?.termsConditionsEn ?? null;
            } catch {
                // ignore
            }
        }

        let finalCxl = cancellationConditions;
        if (!finalCxl) {
            try {
                const policies = await settingsService.getPolicies() as Record<string, string>;
                finalCxl = policies?.cancellationConditionsEn ?? null;
            } catch {
                // ignore
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

            // Hotels
            hotels,

            // Services
            services,

            // Notes & Policies
            specialRequirements,
            customerNotes,
            cancellationConditions: finalCxl,
            termsAndConditions: finalTerms,

            // Totals
            currency,
            totalPrice,
            sellingPricePerRoomPerNight: sellingPrice,
            totalRooms,
        };
    }

    async updateProposalStatus(id: string, status: string) {
        return proposalRepository.update(id, { status });
    }
}

export default new ProposalService();

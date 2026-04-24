"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProposalService = void 0;
const proposal_repository_1 = __importDefault(require("../repositories/proposal.repository"));
const notification_service_1 = __importDefault(require("./notification.service"));
const pdfGeneration_service_1 = require("./pdfGeneration.service");
const request_repository_1 = __importDefault(require("../repositories/request.repository"));
const requests_service_1 = __importDefault(require("./requests.service"));
const settings_service_1 = __importDefault(require("./settings.service"));
const audit_1 = require("../utils/audit");
const client_1 = require("@prisma/client");
const roomUtils_1 = require("../utils/roomUtils");
const logger_1 = __importDefault(require("../utils/logger"));
const storage_service_1 = __importDefault(require("./storage.service"));
const config_1 = __importDefault(require("../config"));
const MODIFIABLE_STATUSES = [client_1.ProposalStatus.draft];
// Selection toggles (includedInTotal) are also allowed on sent proposals,
// because after the initial offer is sent the staff needs to pick the client's
// chosen hotel/services and re-send a final offer.
const SELECTION_MODIFIABLE_STATUSES = [
    client_1.ProposalStatus.draft,
    client_1.ProposalStatus.sent,
];
// `sent` is approvable too — after the initial offer goes out, staff toggles hotels
// and re-approves before sending the final offer.
const APPROVABLE_STATUSES = [
    client_1.ProposalStatus.pending_admin_approval,
    client_1.ProposalStatus.draft,
    client_1.ProposalStatus.sent,
];
// Decline is allowed at more stages than approve — including after the offer was sent,
// because clients may reject the offer after receiving it.
const DECLINABLE_STATUSES = [
    client_1.ProposalStatus.draft,
    client_1.ProposalStatus.pending_admin_approval,
    client_1.ProposalStatus.approved,
    client_1.ProposalStatus.sent,
];
function assertModifiable(proposal) {
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
function assertSelectionEditable(proposal) {
    if (!SELECTION_MODIFIABLE_STATUSES.includes(proposal.status)) {
        throw {
            status: 409,
            message: `Proposal selection cannot be changed in status '${proposal.status}'`,
            code: 'PROPOSAL_NOT_MODIFIABLE',
        };
    }
}
function assertNotLocked(proposal, requestingUserId) {
    const LOCK_TIMEOUT_MS = 15 * 60 * 1000;
    if (proposal.lockedBy &&
        proposal.lockedBy !== requestingUserId &&
        proposal.lockedAt &&
        Date.now() - new Date(proposal.lockedAt).getTime() < LOCK_TIMEOUT_MS) {
        throw {
            status: 409,
            message: 'Proposal is currently locked by another user',
            code: 'PROPOSAL_LOCKED',
            owner: { id: proposal.lockedBy, lockedAt: proposal.lockedAt },
        };
    }
}
class ProposalService {
    /**
     * Fire-and-forget owner-claim on the underlying BookingRequest — called at
     * the start of every mutating proposal action so the first staff member to
     * touch the request becomes its owner. No-ops if requestId/userId missing
     * or the request is already owned.
     */
    claimForRequest(requestId, userId, ip) {
        if (userId && requestId) {
            void requests_service_1.default.claimOwnershipIfUnassigned(requestId, userId, ip, 'auto');
        }
    }
    async getAllProposals() {
        return proposal_repository_1.default.findAll();
    }
    async getProposalById(id) {
        const proposal = await proposal_repository_1.default.findById(id);
        if (!proposal) {
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        }
        return proposal;
    }
    async createProposal(data) {
        return proposal_repository_1.default.create(data);
    }
    async createForRequest(requestId, data, userId, ip) {
        const proposal = await proposal_repository_1.default.createForRequest(requestId, data);
        await (0, audit_1.logAuditEvent)({
            userId,
            action: 'create_proposal',
            entity: 'proposal',
            entityId: proposal.id,
            details: { requestId },
            ipAddress: ip,
        });
        return proposal;
    }
    async updateMetadata(id, data, userId) {
        const existing = await proposal_repository_1.default.findById(id);
        if (!existing)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        assertModifiable(existing);
        assertNotLocked(existing, userId);
        const updated = await proposal_repository_1.default.updateMetadata(id, data);
        await (0, audit_1.logAuditEvent)({
            userId,
            action: 'update_proposal',
            entity: 'proposal',
            entityId: id,
            details: { fields: Object.keys(data) },
        });
        return updated;
    }
    async addHotelToProposal(id, hotelData, userId, ip) {
        const existing = await proposal_repository_1.default.findById(id);
        if (!existing)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        assertModifiable(existing);
        assertNotLocked(existing, userId);
        this.claimForRequest(existing.requestId, userId, ip);
        const result = await proposal_repository_1.default.addHotelTx(id, hotelData, existing.markupSettings ?? undefined);
        await (0, audit_1.logAuditEvent)({
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
    async removeHotelFromProposal(proposalId, hotelId, userId) {
        const existing = await proposal_repository_1.default.findById(proposalId);
        if (!existing)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        if (existing.status === client_1.ProposalStatus.sent) {
            throw {
                status: 409,
                message: 'Cannot remove hotels from a sent proposal',
                code: 'PROPOSAL_NOT_MODIFIABLE',
            };
        }
        assertNotLocked(existing, userId);
        this.claimForRequest(existing.requestId, userId);
        const hotel = existing.hotels.find((h) => h.id === hotelId);
        if (!hotel)
            throw { status: 404, message: 'Hotel not found on this proposal', code: 'NOT_FOUND' };
        const result = await proposal_repository_1.default.removeHotelTx(proposalId, hotelId, hotel);
        await (0, audit_1.logAuditEvent)({
            userId,
            action: 'remove_hotel',
            entity: 'proposal_hotel',
            entityId: hotelId,
            details: { proposalId, snapshot: hotel },
        });
        return result;
    }
    async listHotels(proposalId) {
        const proposal = await proposal_repository_1.default.findById(proposalId);
        if (!proposal)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        return proposal_repository_1.default.findHotels(proposalId);
    }
    async adjustHotelPricing(proposalId, hotelId, data, userId) {
        const existing = await proposal_repository_1.default.findById(proposalId);
        if (!existing)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        assertModifiable(existing);
        assertNotLocked(existing, userId);
        const result = await proposal_repository_1.default.adjustHotelPricing(proposalId, hotelId, data);
        await (0, audit_1.logAuditEvent)({
            userId,
            action: 'adjust_hotel_pricing',
            entity: 'proposal_hotel',
            entityId: hotelId,
            details: { proposalId, changes: data },
        });
        return result;
    }
    async toggleHotelIncluded(proposalId, hotelId, includedInTotal, userId, ip) {
        const existing = await proposal_repository_1.default.findById(proposalId);
        if (!existing)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        // Selection-only guard: allowed on draft AND sent (so staff can pick the client's
        // final choice after the initial offer was sent)
        assertSelectionEditable(existing);
        assertNotLocked(existing, userId);
        // Verify the hotel actually belongs to this proposal and isn't deleted
        const hotel = existing.hotels.find((h) => h.id === hotelId);
        if (!hotel) {
            throw { status: 404, message: 'Hotel not found on this proposal', code: 'NOT_FOUND' };
        }
        const result = await proposal_repository_1.default.toggleHotelIncluded(proposalId, hotelId, includedInTotal);
        await (0, audit_1.logAuditEvent)({
            userId,
            action: 'toggle_hotel_included',
            entity: 'proposal_hotel',
            entityId: hotelId,
            details: { proposalId, includedInTotal },
            ipAddress: ip,
        });
        return result;
    }
    async addServiceToProposal(id, serviceData, userId, ip) {
        const existing = await proposal_repository_1.default.findById(id);
        if (!existing)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        assertModifiable(existing);
        assertNotLocked(existing, userId);
        this.claimForRequest(existing.requestId, userId, ip);
        const result = await proposal_repository_1.default.addServiceTx(id, serviceData, existing.markupSettings ?? undefined);
        await (0, audit_1.logAuditEvent)({
            userId,
            action: 'add_service',
            entity: 'proposal_service',
            entityId: result.service.id,
            details: { proposalId: id, serviceName: serviceData.serviceName },
            ipAddress: ip,
        });
        return result;
    }
    async updateServiceInProposal(proposalId, serviceId, serviceData, userId, ip) {
        const existing = await proposal_repository_1.default.findById(proposalId);
        if (!existing)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        // If the ONLY field being updated is `includedInTotal`, use the lenient selection guard
        // (allows toggling after send, so staff can drop/re-include services for the final offer).
        // Any other change (price, quantity, name, etc.) still requires draft status.
        const keys = Object.keys(serviceData ?? {});
        const selectionOnly = keys.length === 1 && keys[0] === 'includedInTotal';
        if (selectionOnly) {
            assertSelectionEditable(existing);
        }
        else {
            assertModifiable(existing);
        }
        assertNotLocked(existing, userId);
        const result = await proposal_repository_1.default.updateServiceTx(proposalId, serviceId, serviceData);
        if (!result)
            throw { status: 404, message: 'Service not found on this proposal', code: 'NOT_FOUND' };
        await (0, audit_1.logAuditEvent)({
            userId,
            action: 'update_service',
            entity: 'proposal_service',
            entityId: serviceId,
            details: { proposalId, fields: Object.keys(serviceData) },
            ipAddress: ip,
        });
        return result;
    }
    async removeServiceFromProposal(proposalId, serviceId, userId, ip) {
        const existing = await proposal_repository_1.default.findById(proposalId);
        if (!existing)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        assertModifiable(existing);
        assertNotLocked(existing, userId);
        this.claimForRequest(existing.requestId, userId, ip);
        const service = existing.services.find((s) => s.id === serviceId);
        if (!service)
            throw { status: 404, message: 'Service not found on this proposal', code: 'NOT_FOUND' };
        const result = await proposal_repository_1.default.removeServiceTx(proposalId, serviceId);
        if (!result)
            throw { status: 404, message: 'Service not found on this proposal', code: 'NOT_FOUND' };
        await (0, audit_1.logAuditEvent)({
            userId,
            action: 'remove_service',
            entity: 'proposal_service',
            entityId: serviceId,
            details: { proposalId, snapshot: service },
            ipAddress: ip,
        });
        return result;
    }
    async lockProposal(id, userId, ip) {
        const existing = await proposal_repository_1.default.findById(id);
        if (!existing)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        const locked = await proposal_repository_1.default.acquireLock(id, userId);
        if (!locked) {
            // Lock held by someone else — fetch current lock owner info
            throw {
                status: 409,
                message: 'Proposal is currently locked by another user',
                code: 'PROPOSAL_LOCKED',
                owner: { id: existing.lockedBy, lockedAt: existing.lockedAt },
            };
        }
        await (0, audit_1.logAuditEvent)({ userId, action: 'lock_proposal', entity: 'proposal', entityId: id, ipAddress: ip });
        return locked;
    }
    async unlockProposal(id, userId) {
        const existing = await proposal_repository_1.default.findById(id);
        if (!existing)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        await proposal_repository_1.default.releaseLock(id, userId);
        await (0, audit_1.logAuditEvent)({ userId, action: 'unlock_proposal', entity: 'proposal', entityId: id });
        return proposal_repository_1.default.findById(id);
    }
    async saveDraft(id, userId) {
        const existing = await proposal_repository_1.default.findById(id);
        if (!existing)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        await proposal_repository_1.default.setDraft(id);
        await (0, audit_1.logAuditEvent)({ userId, action: 'save_draft', entity: 'proposal', entityId: id });
        return proposal_repository_1.default.findById(id);
    }
    async sendProposal(id, data, userId, ip) {
        const existing = await proposal_repository_1.default.findById(id);
        if (!existing)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        this.claimForRequest(existing.requestId, userId, ip);
        // Re-sending a `sent` proposal is now allowed — the second send becomes
        // the final offer (after the client picks a hotel). The backend auto-detects
        // type via offerNumber count.
        if (existing.status === client_1.ProposalStatus.declined) {
            throw { status: 409, message: 'Cannot send a declined proposal', code: 'PROPOSAL_NOT_MODIFIABLE' };
        }
        // Resolve recipients — sendToEmails (array) > sendToEmail (single) > booking request contact email
        const request = existing.bookingRequest;
        let recipients = [];
        if (data.sendToEmails && data.sendToEmails.length > 0) {
            recipients = data.sendToEmails;
        }
        else if (data.sendToEmail) {
            recipients = [data.sendToEmail];
        }
        else if (request?.contactEmail) {
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
        let pdfBuffer;
        let pdfData;
        try {
            pdfData = await this.buildPdfData(existing);
            pdfBuffer = await (0, pdfGeneration_service_1.generateOfferPdf)(pdfData);
        }
        catch (err) {
            logger_1.default.error({ err, proposalId: id }, 'sendProposal: PDF generation failed');
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
        const offerCount = await proposal_repository_1.default.countOffers(id);
        const offerNumber = offerCount + 1;
        const offerType = offerCount === 0 ? 'initial' :
            offerCount === 1 ? 'final' :
                'revision';
        // Upload the PDF to S3 (if configured) BEFORE attempting the email send.
        // This way we have a stored artifact even if the email fails — and we can
        // clean up orphans later if needed.
        let pdfKey = '';
        let pdfUrl = '';
        try {
            if (config_1.default.s3.endpoint && config_1.default.s3.accessKeyId) {
                const filename = `offer-${offerNumber}-${offerType}-${Date.now()}`;
                pdfUrl = await storage_service_1.default.uploadPdf(id, filename, pdfBuffer);
                // Rebuild the S3 key (uploadPdf uses this pattern internally)
                pdfKey = `proposals/${id}/${filename}.pdf`;
            }
            else {
                // Fallback: data URI for local dev without S3
                pdfUrl = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;
                pdfKey = `data-uri-offer-${offerNumber}`;
                logger_1.default.warn({ proposalId: id }, 'S3 not configured — offer PDF stored as data URI');
            }
        }
        catch (err) {
            logger_1.default.error({ err, proposalId: id }, 'sendProposal: PDF upload to S3 failed — will still attempt to send email');
        }
        // Attempt to send the email (Gmail API → SMTP fallback handled by notification service)
        const refNum = request?.referenceNumber ?? 0;
        const contactName = request?.contactName ?? request?.firstName ?? 'Guest';
        const destinationName = request?.destinationName ?? 'Unknown';
        // notification.sendOfferPdfToAgent does NOT throw for normal failures — it returns
        // a discriminated union (EmailSendResult). Inspect ok/failure to decide what to do.
        const sendResult = await notification_service_1.default.sendOfferPdfToAgent({
            agentEmail: recipientEmail,
            referenceNumber: refNum,
            contactName,
            destinationName,
            pdfBuffer,
            userId,
        });
        // CRITICAL: only mark proposal as 'sent' if the email actually went through.
        // Otherwise the status stays unchanged so the user can retry.
        if (!sendResult.ok) {
            await (0, audit_1.logAuditEvent)({
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
        const updated = await proposal_repository_1.default.setSent(id, userId, recipientEmail);
        if (existing.requestId) {
            await request_repository_1.default.updateStatus(existing.requestId, 'sent');
        }
        // Build hotel & service snapshots so we can later reconstruct what was in each offer
        const activeHotels = (existing.hotels ?? []).filter((h) => !h.deletedAt);
        const hotelSnapshot = activeHotels.map((h) => ({
            hotelCode: h.hotelCode,
            hotelName: h.hotelName ?? null,
            includedInTotal: h.includedInTotal !== false,
            totalPrice: h.totalPrice ? Number(h.totalPrice) : null,
            currency: h.currency ?? null,
        }));
        const serviceSnapshot = (existing.services ?? []).map((s) => ({
            serviceName: s.serviceName,
            includedInTotal: s.includedInTotal !== false,
            sellPrice: s.sellPrice ? Number(s.sellPrice) : null,
            quantity: s.quantity ?? 1,
            days: s.days ?? 1,
            currency: s.currency ?? null,
        }));
        let offerRow = null;
        try {
            offerRow = await proposal_repository_1.default.createOffer({
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
        }
        catch (err) {
            // Don't fail the whole send if history row fails — the email went out successfully.
            logger_1.default.error({ err, proposalId: id }, 'sendProposal: failed to create ProposalOffer history row');
        }
        await (0, audit_1.logAuditEvent)({
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
                includedHotels: activeHotels.filter((h) => h.includedInTotal !== false).length,
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
    async previewPdf(id) {
        const existing = await proposal_repository_1.default.findById(id);
        if (!existing)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        // Generate a preview PDF buffer (same as approval PDF but not persisted)
        const pdfData = await this.buildPdfData(existing);
        const pdfBuffer = await (0, pdfGeneration_service_1.generateOfferPdf)(pdfData);
        return { pdfBuffer, note: 'Preview PDF generated' };
    }
    /** List all offers sent for a proposal (history). */
    async listOffers(proposalId) {
        const proposal = await proposal_repository_1.default.findById(proposalId);
        if (!proposal)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        const offers = await proposal_repository_1.default.listOffers(proposalId);
        return offers.map((o) => ({
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
                ? o.hotelSnapshot.filter((h) => h.includedInTotal).length
                : 0,
            serviceCount: Array.isArray(o.serviceSnapshot)
                ? o.serviceSnapshot.filter((s) => s.includedInTotal).length
                : 0,
        }));
    }
    /** Download the PDF for a specific offer (by offer id). */
    async downloadOfferPdf(proposalId, offerId) {
        const offer = await proposal_repository_1.default.getOfferById(offerId);
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
        const pdfBuffer = await storage_service_1.default.downloadPdf(offer.pdfKey);
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
    async approveProposal(id, data, userId, ip) {
        const existing = await proposal_repository_1.default.findById(id);
        if (!existing)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        if (!APPROVABLE_STATUSES.includes(existing.status)) {
            throw {
                status: 409,
                message: `Proposal cannot be approved in status '${existing.status}'. Must be 'pending_admin_approval' or 'draft'.`,
                code: 'PROPOSAL_NOT_APPROVABLE',
            };
        }
        // Generate PDF
        let pdfBuffer = null;
        let pdfUrl = null;
        try {
            const pdfData = await this.buildPdfData(existing);
            pdfBuffer = await (0, pdfGeneration_service_1.generateOfferPdf)(pdfData);
            // Upload to S3 if configured, otherwise fall back to data URI (local dev)
            if (config_1.default.s3.endpoint && config_1.default.s3.accessKeyId) {
                const filename = `offer-${Date.now()}`;
                pdfUrl = await storage_service_1.default.uploadPdf(id, filename, pdfBuffer);
            }
            else {
                pdfUrl = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;
                logger_1.default.warn({ proposalId: id }, 'S3 not configured — storing PDF as data URI');
            }
            console.log(`[Step 4.2] PDF generated for proposal ${id} (${pdfBuffer.length} bytes)`);
        }
        catch (err) {
            logger_1.default.error({ err, proposalId: id }, 'Step 4.2: PDF generation failed — approving without PDF');
            console.log(`[Step 4.2] WARNING: PDF generation failed for proposal ${id}: ${err.message}`);
        }
        // Update status to approved
        const updated = await proposal_repository_1.default.setApproved(id, userId, pdfUrl ?? undefined);
        const request = existing.bookingRequest;
        const refNum = request?.referenceNumber ?? 0;
        const contactName = request?.contactName ?? request?.firstName ?? 'Guest';
        const destinationName = request?.destinationName ?? 'Unknown';
        const agentEmail = data.agentEmail ?? request?.contactEmail;
        // In-app notification for staff (no email — that comes from /send)
        try {
            await notification_service_1.default.notifyOfferApproved({
                requestId: existing.requestId ?? '',
                proposalId: id,
                referenceNumber: refNum,
                contactName,
                destinationName,
                approvedBy: userId,
                agentEmail,
            });
        }
        catch (err) {
            logger_1.default.error({ err, proposalId: id }, 'Step 4.2: Failed to send approval notification — proposal is still approved');
            console.log(`[Step 4.2] WARNING: Approval notification failed for proposal ${id}: ${err.message}`);
        }
        try {
            await (0, audit_1.logAuditEvent)({
                userId,
                action: 'approve_proposal',
                entity: 'proposal',
                entityId: id,
                details: { agentEmail, pdfGenerated: !!pdfBuffer, adminNotes: data.adminNotes },
                ipAddress: ip,
            });
        }
        catch (err) {
            logger_1.default.error({ err, proposalId: id }, 'Step 4.2: Audit log failed — proposal is still approved');
        }
        console.log(`[Step 4.2] Proposal ${id} APPROVED by ${userId}. PDF=${!!pdfBuffer}`);
        logger_1.default.info({ proposalId: id, userId, pdfGenerated: !!pdfBuffer }, 'Step 4.2: Proposal approved');
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
    async declineProposal(id, data, userId, ip) {
        const existing = await proposal_repository_1.default.findById(id);
        if (!existing)
            throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
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
        const updated = await proposal_repository_1.default.setDeclined(id, userId, data.rejectionReason.trim());
        // Update parent booking request status to 'declined' so the requests list
        // reflects the client's decision instead of still showing 'sent'.
        if (existing.requestId) {
            try {
                await request_repository_1.default.updateStatus(existing.requestId, 'declined');
            }
            catch (err) {
                logger_1.default.error({ err, requestId: existing.requestId, proposalId: id }, 'Failed to update parent BookingRequest status to declined — proposal is still declined');
            }
        }
        // Notify staff via in-app + email
        const request = existing.bookingRequest;
        const refNum = request?.referenceNumber ?? 0;
        const contactName = request?.contactName ?? request?.firstName ?? 'Guest';
        const destinationName = request?.destinationName ?? 'Unknown';
        try {
            await notification_service_1.default.notifyOfferDeclined({
                requestId: existing.requestId ?? '',
                proposalId: id,
                referenceNumber: refNum,
                contactName,
                destinationName,
                rejectedBy: userId,
                rejectionReason: data.rejectionReason.trim(),
                staffEmail: process.env.STAFF_NOTIFICATION_EMAIL,
            });
        }
        catch (err) {
            logger_1.default.error({ err, proposalId: id }, 'Step 4.2: Failed to send decline notification — proposal is still declined');
        }
        try {
            await (0, audit_1.logAuditEvent)({
                userId,
                action: 'decline_proposal',
                entity: 'proposal',
                entityId: id,
                details: { rejectionReason: data.rejectionReason },
                ipAddress: ip,
            });
        }
        catch (err) {
            logger_1.default.error({ err, proposalId: id }, 'Step 4.2: Audit log failed — proposal is still declined');
        }
        console.log(`[Step 4.2] Proposal ${id} DECLINED by ${userId}. Reason: ${data.rejectionReason}`);
        logger_1.default.info({ proposalId: id, userId, rejectionReason: data.rejectionReason }, 'Step 4.2: Proposal declined');
        return { proposal: updated };
    }
    /**
     * Build PDF data from a proposal + its booking request.
     */
    async buildPdfData(proposal) {
        const request = proposal.bookingRequest;
        // ── Company details from settings ────────────────────────────────
        let companyDetails = {};
        try {
            companyDetails = await settings_service_1.default.getCompanyDetails();
        }
        catch {
            logger_1.default.warn('buildPdfData: Could not fetch company details from settings');
        }
        // ── Client & trip info from booking request ─────────────────────
        const refNum = request?.referenceNumber ?? 0;
        const contactName = request?.contactName ?? request?.firstName ?? 'Guest';
        const companyNameClient = request?.companyName ?? '';
        const contactEmail = request?.contactEmail ?? '';
        const contactPhone = request?.contactPhone ?? '';
        const contactPhoneCountryCode = request?.contactPhoneCountryCode ?? null;
        const destinationName = request?.destinationName ?? 'Unknown';
        const checkinDate = request?.checkinDate
            ? new Date(request.checkinDate).toISOString().split('T')[0]
            : '';
        const checkoutDate = request?.checkoutDate
            ? new Date(request.checkoutDate).toISOString().split('T')[0]
            : '';
        const nights = request?.nights ?? 1;
        const totalRooms = (0, roomUtils_1.countTotalRooms)(request?.rooms);
        const mealPlan = request?.breakfastPreference ?? 'RO';
        const specialRequirements = request?.specialRequirements ?? null;
        const customerNotes = request?.customerNotes ?? null;
        const cancellationConditions = request?.cancellationConditions ?? null;
        const termsAndConditions = request?.termsAndConditions ?? null;
        // ── Hotels ───────────────────────────────────────────────────────
        // Show only non-deleted hotels that are marked for inclusion in the total.
        // Excluded hotels (Oliver's "options") don't appear in the customer-facing PDF.
        const activeHotels = (proposal.hotels ?? []).filter((h) => !h.deletedAt && h.includedInTotal !== false);
        let sellingPrice = 0;
        let currency = 'EUR';
        let totalPrice = 0;
        for (const h of activeHotels) {
            const rooms = h.rooms;
            if (rooms?.standard?.sell && sellingPrice === 0) {
                sellingPrice = rooms.standard.sell;
            }
            totalPrice += Number(h.totalPrice ?? 0);
            if (h.currency)
                currency = h.currency;
        }
        // Map hotel entries — each ProposalHotel has a rooms JSON with one or more room type keys
        // e.g. { double: { qty: 20, sell: 178, net: 155, nights: 3 } }
        // or legacy: { standard: { qty: 30, sell: 178, net: 155, nights: 3 } }
        const hotels = activeHotels.map((h) => {
            const hRooms = h.rooms ?? {};
            // Find the room type key — first non-standard key, or 'standard', or fallback to 'double'
            const roomTypeKeys = Object.keys(hRooms);
            const roomType = roomTypeKeys.find((k) => k !== 'standard') ?? roomTypeKeys[0] ?? 'double';
            const roomData = hRooms[roomType] ?? {};
            const qty = roomData.qty ?? 0;
            const sell = roomData.sell ?? sellingPrice;
            return {
                hotelName: h.hotelName ?? h.hotelCode ?? 'Unknown Hotel',
                starRating: null,
                addressCity: null,
                addressCountry: null,
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
            .filter((s) => s.includedInTotal !== false)
            .map((s) => ({
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
                const policies = await settings_service_1.default.getPolicies();
                finalTerms = policies?.termsConditionsEn ?? null;
            }
            catch {
                // ignore
            }
        }
        let finalCxl = cancellationConditions;
        if (!finalCxl) {
            try {
                const policies = await settings_service_1.default.getPolicies();
                finalCxl = policies?.cancellationConditionsEn ?? null;
            }
            catch {
                // ignore
            }
        }
        return {
            // Company
            companyName: companyDetails.companyName ?? 'S & T T WORLDWIDE RESERVATION FZE',
            companyAddress: companyDetails.address ?? '',
            companyPhone: companyDetails.phoneNumber ?? '',
            companyPhoneCountryCode: companyDetails.phoneCountryCode ?? null,
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
    async updateProposalStatus(id, status) {
        return proposal_repository_1.default.update(id, { status });
    }
}
exports.ProposalService = ProposalService;
exports.default = new ProposalService();

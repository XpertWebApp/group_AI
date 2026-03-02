import proposalRepository from '../repositories/proposal.repository';
import { logAuditEvent } from '../utils/audit';
import { ProposalStatus } from '@prisma/client';

const MODIFIABLE_STATUSES: ProposalStatus[] = [ProposalStatus.draft];

function assertModifiable(proposal: any) {
    if (!MODIFIABLE_STATUSES.includes(proposal.status)) {
        throw {
            status: 409,
            message: `Proposal cannot be modified in status '${proposal.status}'`,
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

    async addServiceToProposal(id: string, serviceData: any, userId?: string, ip?: string) {
        const existing = await proposalRepository.findById(id);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };
        assertModifiable(existing);
        assertNotLocked(existing, userId);

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

        const updated = await proposalRepository.setDraft(id);
        await logAuditEvent({ userId, action: 'save_draft', entity: 'proposal', entityId: id });

        return updated;
    }

    async sendProposal(id: string, data: { sendToEmail?: string }, userId: string, ip?: string) {
        const existing = await proposalRepository.findById(id);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };

        if (existing.status === ProposalStatus.sent) {
            throw { status: 409, message: 'Proposal already sent', code: 'PROPOSAL_ALREADY_SENT' };
        }
        if (existing.status === ProposalStatus.declined) {
            throw { status: 409, message: 'Cannot send a declined proposal', code: 'PROPOSAL_NOT_MODIFIABLE' };
        }

        const updated = await proposalRepository.setSent(id, userId, data.sendToEmail);

        await logAuditEvent({
            userId,
            action: 'send_proposal',
            entity: 'proposal',
            entityId: id,
            details: { sentToEmail: data.sendToEmail ?? null },
            ipAddress: ip,
        });

        return {
            sent: true,
            emailSent: false,
            previewUrl: null,
            sendPlaceholder: true,
            proposal: updated,
        };
    }

    async previewPdf(id: string) {
        const existing = await proposalRepository.findById(id);
        if (!existing) throw { status: 404, message: 'Proposal not found', code: 'NOT_FOUND' };

        // TODO: PDF generation will be implemented in a later milestone
        return { previewUrl: null, note: 'PDF generation pending' };
    }

    async updateProposalStatus(id: string, status: string) {
        return proposalRepository.update(id, { status });
    }
}

export default new ProposalService();

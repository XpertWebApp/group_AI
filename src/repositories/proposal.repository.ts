import { PrismaClient, Proposal, ProposalHotel, ProposalService } from '@prisma/client';

const prisma = new PrismaClient();

export class ProposalRepository {
    async findAll() {
        return prisma.proposal.findMany({
            include: { bookingRequest: true },
            orderBy: { createdAt: 'desc' },
        });
    }

    async findById(id: string) {
        return prisma.proposal.findUnique({
            where: { id },
            include: {
                bookingRequest: true,
                hotels: true,
                services: true,
            },
        });
    }

    async create(data: any) {
        return prisma.proposal.create({
            data,
        });
    }

    async update(id: string, data: any) {
        return prisma.proposal.update({
            where: { id },
            data: { ...data, updatedAt: new Date() },
        });
    }

    async addHotel(proposalId: string, hotelData: any) {
        return prisma.proposalHotel.create({
            data: {
                ...hotelData,
                proposalId,
            },
        });
    }

    async addService(proposalId: string, serviceData: any) {
        return prisma.proposalService.create({
            data: {
                ...serviceData,
                proposalId,
            },
        });
    }
}

export default new ProposalRepository();

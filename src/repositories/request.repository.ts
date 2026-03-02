import { PrismaClient, BookingRequestStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';

const prisma = new PrismaClient();

export class RequestRepository {
    async findAll() {
        return prisma.bookingRequest.findMany({
            orderBy: { createdAt: 'desc' },
            include: {
                proposals: {
                    select: { id: true, status: true, totalBuy: true, totalSell: true, createdAt: true },
                },
            },
        });
    }

    async findById(id: string) {
        return prisma.bookingRequest.findUnique({
            where: { id },
            include: {
                proposals: {
                    include: { hotels: { where: { deletedAt: null } }, services: true },
                },
                attachments: true,
            },
        });
    }

    async findSummary(id: string) {
        return prisma.bookingRequest.findUnique({
            where: { id },
            select: {
                id: true,
                companyName: true,
                contactName: true,
                contactEmail: true,
                contactPhone: true,
                destinationId: true,
                destinationName: true,
                checkinDate: true,
                nights: true,
                rooms: true,
                currencyCode: true,
                budget: true,
                specialRequirements: true,
                status: true,
                nationalityCode: true,
                createdAt: true,
                updatedAt: true,
                proposals: {
                    select: {
                        id: true,
                        status: true,
                        totalBuy: true,
                        totalSell: true,
                        markupSettings: true,
                        sentAt: true,
                        createdAt: true,
                    },
                },
            },
        });
    }

    async create(data: Prisma.BookingRequestCreateInput) {
        return prisma.bookingRequest.create({ data });
    }

    async update(id: string, data: Prisma.BookingRequestUpdateInput) {
        return prisma.bookingRequest.update({
            where: { id },
            data: { ...data },
        });
    }

    async updateStatus(id: string, status: BookingRequestStatus) {
        return prisma.bookingRequest.update({
            where: { id },
            data: { status },
        });
    }
}

export default new RequestRepository();

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookRepository = void 0;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
class WebhookRepository {
    async createBookingRequest(data) {
        return prisma.bookingRequest.create({
            data,
        });
    }
    async findById(id) {
        return prisma.bookingRequest.findUnique({
            where: { id },
        });
    }
}
exports.WebhookRepository = WebhookRepository;
exports.default = new WebhookRepository();

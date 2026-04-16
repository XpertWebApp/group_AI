"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationRepository = void 0;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
class NotificationRepository {
    async create(data) {
        return prisma.notification.create({ data });
    }
    async findAll(opts = {}) {
        return prisma.notification.findMany({
            where: opts.unreadOnly ? { read: false } : undefined,
            orderBy: { createdAt: 'desc' },
            take: opts.limit ?? 50,
        });
    }
    async markRead(id) {
        return prisma.notification.update({ where: { id }, data: { read: true } });
    }
    async markAllRead() {
        return prisma.notification.updateMany({ where: { read: false }, data: { read: true } });
    }
    async unreadCount() {
        return prisma.notification.count({ where: { read: false } });
    }
}
exports.NotificationRepository = NotificationRepository;
exports.default = new NotificationRepository();

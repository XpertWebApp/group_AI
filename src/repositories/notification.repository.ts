import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface CreateNotificationData {
    type: string;
    title: string;
    message: string;
    entityId?: string;
    entityType?: string;
}

export class NotificationRepository {
    async create(data: CreateNotificationData) {
        return prisma.notification.create({ data });
    }

    async findAll(opts: { unreadOnly?: boolean; limit?: number } = {}) {
        return prisma.notification.findMany({
            where: opts.unreadOnly ? { read: false } : undefined,
            orderBy: { createdAt: 'desc' },
            take: opts.limit ?? 50,
        });
    }

    async markRead(id: string) {
        return prisma.notification.update({ where: { id }, data: { read: true } });
    }

    async markAllRead() {
        return prisma.notification.updateMany({ where: { read: false }, data: { read: true } });
    }

    async unreadCount(): Promise<number> {
        return prisma.notification.count({ where: { read: false } });
    }
}

export default new NotificationRepository();

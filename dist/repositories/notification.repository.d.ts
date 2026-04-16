export interface CreateNotificationData {
    type: string;
    title: string;
    message: string;
    entityId?: string;
    entityType?: string;
}
export declare class NotificationRepository {
    create(data: CreateNotificationData): Promise<{
        id: string;
        createdAt: Date;
        message: string;
        type: string;
        entityId: string | null;
        title: string;
        entityType: string | null;
        read: boolean;
    }>;
    findAll(opts?: {
        unreadOnly?: boolean;
        limit?: number;
    }): Promise<{
        id: string;
        createdAt: Date;
        message: string;
        type: string;
        entityId: string | null;
        title: string;
        entityType: string | null;
        read: boolean;
    }[]>;
    markRead(id: string): Promise<{
        id: string;
        createdAt: Date;
        message: string;
        type: string;
        entityId: string | null;
        title: string;
        entityType: string | null;
        read: boolean;
    }>;
    markAllRead(): Promise<import(".prisma/client").Prisma.BatchPayload>;
    unreadCount(): Promise<number>;
}
declare const _default: NotificationRepository;
export default _default;

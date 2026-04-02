import { PrismaClient, User, UserRole } from '@prisma/client';

const prisma = new PrismaClient();

export class UserRepository {
    async findByEmail(email: string): Promise<User | null> {
        return prisma.user.findUnique({
            where: { email },
            include: { role: true },
        });
    }

    async findById(id: string): Promise<User | null> {
        return prisma.user.findUnique({
            where: { id },
            include: { role: true },
        });
    }

    async createRole(name: string, description?: string): Promise<UserRole> {
        return prisma.userRole.create({
            data: { name, description },
        });
    }

    async createUser(data: any): Promise<User> {
        if (data.email && typeof data.email === 'string') {
            data.email = data.email.toLowerCase();
        }
        return prisma.user.create({
            data,
        });
    }

    async updateRefreshToken(userId: string, hashedToken: string | null): Promise<User> {
        return prisma.user.update({
            where: { id: userId },
            data: { refreshToken: hashedToken },
        });
    }

    async updateGoogleTokens(userId: string, data: {
        googleAccessToken: string | null;
        googleRefreshToken: string | null;
        googleTokenExpiry: Date | null;
    }): Promise<User> {
        return prisma.user.update({
            where: { id: userId },
            data,
        });
    }

    async getGoogleTokens(userId: string): Promise<{
        email: string;
        googleAccessToken: string | null;
        googleRefreshToken: string | null;
        googleTokenExpiry: Date | null;
    } | null> {
        return prisma.user.findUnique({
            where: { id: userId },
            select: {
                email: true,
                googleAccessToken: true,
                googleRefreshToken: true,
                googleTokenExpiry: true,
            },
        });
    }

    async clearGoogleTokens(userId: string): Promise<User> {
        return prisma.user.update({
            where: { id: userId },
            data: {
                googleAccessToken: null,
                googleRefreshToken: null,
                googleTokenExpiry: null,
            },
        });
    }
}

export default new UserRepository();

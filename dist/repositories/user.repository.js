"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserRepository = void 0;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
class UserRepository {
    async findByEmail(email) {
        return prisma.user.findUnique({
            where: { email },
            include: { role: true },
        });
    }
    async findById(id) {
        return prisma.user.findUnique({
            where: { id },
            include: { role: true },
        });
    }
    async createRole(name, description) {
        return prisma.userRole.create({
            data: { name, description },
        });
    }
    async createUser(data) {
        if (data.email && typeof data.email === 'string') {
            data.email = data.email.toLowerCase();
        }
        return prisma.user.create({
            data,
        });
    }
    async updateRefreshToken(userId, hashedToken) {
        return prisma.user.update({
            where: { id: userId },
            data: { refreshToken: hashedToken },
        });
    }
}
exports.UserRepository = UserRepository;
exports.default = new UserRepository();

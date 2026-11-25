import crypto from 'crypto';
import bcrypt from 'bcrypt';
import staffRepository, { StaffRow } from '../repositories/staff.repository';
import userRepository from '../repositories/user.repository';
import { logAuditEvent } from '../utils/audit';

interface StaffListItem {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    fullName: string;
    role: string;
    status: 'active' | 'blocked';
    lastLoginAt: Date | null;
    createdAt: Date;
}

function mapToListItem(row: StaffRow): StaffListItem {
    const firstName = row.firstName ?? '';
    const lastName = row.lastName ?? '';
    return {
        id: row.id,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        fullName: `${firstName} ${lastName}`.trim() || row.email,
        role: row.role.name === 'ADMIN' ? 'Admin' : 'Staff',
        status: row.isActive ? 'active' : 'blocked',
        lastLoginAt: row.lastLoginAt,
        createdAt: row.createdAt,
    };
}

function generateSecurePassword(): string {
    const length = 12;
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const digits = '0123456789';
    const symbols = '!@#$%&*?';
    const all = upper + lower + digits + symbols;

    // Guarantee at least one from each category
    const guaranteed = [
        upper[crypto.randomInt(upper.length)],
        lower[crypto.randomInt(lower.length)],
        digits[crypto.randomInt(digits.length)],
        symbols[crypto.randomInt(symbols.length)],
    ];

    // Fill the rest randomly from all characters
    for (let i = guaranteed.length; i < length; i++) {
        guaranteed.push(all[crypto.randomInt(all.length)]);
    }

    // Shuffle using Fisher-Yates
    for (let i = guaranteed.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [guaranteed[i], guaranteed[j]] = [guaranteed[j], guaranteed[i]];
    }

    return guaranteed.join('');
}

function parseFullName(fullName: string): { firstName: string; lastName: string | null } {
    const trimmed = fullName.trim();
    const spaceIndex = trimmed.indexOf(' ');
    if (spaceIndex === -1) {
        return { firstName: trimmed, lastName: null };
    }
    return {
        firstName: trimmed.substring(0, spaceIndex),
        lastName: trimmed.substring(spaceIndex + 1).trim() || null,
    };
}

export class StaffService {
    async listStaff(opts: {
        search?: string;
        status?: 'active' | 'blocked';
        page?: number;
        limit?: number;
    }) {
        const result = await staffRepository.findAll(opts);
        return {
            data: result.data.map(mapToListItem),
            total: result.total,
            page: result.page,
            limit: result.limit,
        };
    }

    async addStaff(
        input: { fullName: string; email: string },
        adminUserId: string,
    ): Promise<{ email: string; oneTimePassword: string }> {
        const existing = await userRepository.findByEmail(input.email);
        if (existing) {
            throw { status: 409, message: 'A user with this email already exists', code: 'CONFLICT' };
        }

        const { firstName, lastName } = parseFullName(input.fullName);
        const oneTimePassword = generateSecurePassword();
        const hashedPassword = await bcrypt.hash(oneTimePassword, 10);
        const userRole = await staffRepository.getUserRole();

        await staffRepository.create({
            email: input.email.toLowerCase(),
            password: hashedPassword,
            firstName,
            lastName,
            roleId: userRole.id,
        });

        logAuditEvent({
            userId: adminUserId,
            action: 'STAFF_CREATED',
            entity: 'User',
            details: { email: input.email, fullName: input.fullName },
        });

        return { email: input.email.toLowerCase(), oneTimePassword };
    }

    async toggleStaffStatus(
        staffId: string,
        action: 'block' | 'unblock',
        adminUserId: string,
    ): Promise<StaffListItem> {
        const staff = await staffRepository.findById(staffId);
        if (!staff) {
            throw { status: 404, message: 'Staff member not found', code: 'NOT_FOUND' };
        }

        if (staff.id === adminUserId) {
            throw { status: 400, message: 'You cannot block or unblock yourself', code: 'BAD_REQUEST' };
        }

        if (staff.role.name === 'ADMIN') {
            throw { status: 400, message: 'Cannot change status of an admin user', code: 'BAD_REQUEST' };
        }

        const isActive = action === 'unblock';
        const updated = await staffRepository.updateStatus(staffId, isActive);

        logAuditEvent({
            userId: adminUserId,
            action: action === 'block' ? 'STAFF_BLOCKED' : 'STAFF_UNBLOCKED',
            entity: 'User',
            entityId: staffId,
            details: { email: staff.email },
        });

        return mapToListItem(updated);
    }

    async resetPassword(
        staffId: string,
        adminUserId: string,
    ): Promise<{ email: string; oneTimePassword: string }> {
        const staff = await staffRepository.findById(staffId);
        if (!staff) {
            throw { status: 404, message: 'Staff member not found', code: 'NOT_FOUND' };
        }

        const oneTimePassword = generateSecurePassword();
        const hashedPassword = await bcrypt.hash(oneTimePassword, 10);

        await staffRepository.updatePassword(staffId, hashedPassword);

        logAuditEvent({
            userId: adminUserId,
            action: 'STAFF_PASSWORD_RESET',
            entity: 'User',
            entityId: staffId,
            details: { email: staff.email },
        });

        return { email: staff.email, oneTimePassword };
    }

    async deleteStaff(staffId: string, adminUserId: string): Promise<void> {
        const staff = await staffRepository.findById(staffId);
        if (!staff) {
            throw { status: 404, message: 'Staff member not found', code: 'NOT_FOUND' };
        }

        if (staff.id === adminUserId) {
            throw { status: 400, message: 'You cannot delete yourself', code: 'BAD_REQUEST' };
        }

        if (staff.role.name === 'ADMIN') {
            throw { status: 400, message: 'Cannot delete an admin user', code: 'BAD_REQUEST' };
        }

        await staffRepository.delete(staffId);

        logAuditEvent({
            userId: adminUserId,
            action: 'STAFF_DELETED',
            entity: 'User',
            entityId: staffId,
            details: { email: staff.email },
        });
    }
}

export default new StaffService();

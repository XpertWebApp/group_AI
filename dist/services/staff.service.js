"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StaffService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const staff_repository_1 = __importDefault(require("../repositories/staff.repository"));
const user_repository_1 = __importDefault(require("../repositories/user.repository"));
const audit_1 = require("../utils/audit");
function mapToListItem(row) {
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
function generateSecurePassword() {
    const length = 12;
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const digits = '0123456789';
    const symbols = '!@#$%&*?';
    const all = upper + lower + digits + symbols;
    // Guarantee at least one from each category
    const guaranteed = [
        upper[crypto_1.default.randomInt(upper.length)],
        lower[crypto_1.default.randomInt(lower.length)],
        digits[crypto_1.default.randomInt(digits.length)],
        symbols[crypto_1.default.randomInt(symbols.length)],
    ];
    // Fill the rest randomly from all characters
    for (let i = guaranteed.length; i < length; i++) {
        guaranteed.push(all[crypto_1.default.randomInt(all.length)]);
    }
    // Shuffle using Fisher-Yates
    for (let i = guaranteed.length - 1; i > 0; i--) {
        const j = crypto_1.default.randomInt(i + 1);
        [guaranteed[i], guaranteed[j]] = [guaranteed[j], guaranteed[i]];
    }
    return guaranteed.join('');
}
function parseFullName(fullName) {
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
class StaffService {
    async listStaff(opts) {
        const result = await staff_repository_1.default.findAll(opts);
        return {
            data: result.data.map(mapToListItem),
            total: result.total,
            page: result.page,
            limit: result.limit,
        };
    }
    async addStaff(input, adminUserId) {
        const existing = await user_repository_1.default.findByEmail(input.email);
        if (existing) {
            throw { status: 409, message: 'A user with this email already exists', code: 'CONFLICT' };
        }
        const { firstName, lastName } = parseFullName(input.fullName);
        const oneTimePassword = generateSecurePassword();
        const hashedPassword = await bcrypt_1.default.hash(oneTimePassword, 10);
        const userRole = await staff_repository_1.default.getUserRole();
        await staff_repository_1.default.create({
            email: input.email.toLowerCase(),
            password: hashedPassword,
            firstName,
            lastName,
            roleId: userRole.id,
        });
        (0, audit_1.logAuditEvent)({
            userId: adminUserId,
            action: 'STAFF_CREATED',
            entity: 'User',
            details: { email: input.email, fullName: input.fullName },
        });
        return { email: input.email.toLowerCase(), oneTimePassword };
    }
    async toggleStaffStatus(staffId, action, adminUserId) {
        const staff = await staff_repository_1.default.findById(staffId);
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
        const updated = await staff_repository_1.default.updateStatus(staffId, isActive);
        (0, audit_1.logAuditEvent)({
            userId: adminUserId,
            action: action === 'block' ? 'STAFF_BLOCKED' : 'STAFF_UNBLOCKED',
            entity: 'User',
            entityId: staffId,
            details: { email: staff.email },
        });
        return mapToListItem(updated);
    }
    async resetPassword(staffId, adminUserId) {
        const staff = await staff_repository_1.default.findById(staffId);
        if (!staff) {
            throw { status: 404, message: 'Staff member not found', code: 'NOT_FOUND' };
        }
        const oneTimePassword = generateSecurePassword();
        const hashedPassword = await bcrypt_1.default.hash(oneTimePassword, 10);
        await staff_repository_1.default.updatePassword(staffId, hashedPassword);
        (0, audit_1.logAuditEvent)({
            userId: adminUserId,
            action: 'STAFF_PASSWORD_RESET',
            entity: 'User',
            entityId: staffId,
            details: { email: staff.email },
        });
        return { email: staff.email, oneTimePassword };
    }
    async deleteStaff(staffId, adminUserId) {
        const staff = await staff_repository_1.default.findById(staffId);
        if (!staff) {
            throw { status: 404, message: 'Staff member not found', code: 'NOT_FOUND' };
        }
        if (staff.id === adminUserId) {
            throw { status: 400, message: 'You cannot delete yourself', code: 'BAD_REQUEST' };
        }
        if (staff.role.name === 'ADMIN') {
            throw { status: 400, message: 'Cannot delete an admin user', code: 'BAD_REQUEST' };
        }
        await staff_repository_1.default.delete(staffId);
        (0, audit_1.logAuditEvent)({
            userId: adminUserId,
            action: 'STAFF_DELETED',
            entity: 'User',
            entityId: staffId,
            details: { email: staff.email },
        });
    }
}
exports.StaffService = StaffService;
exports.default = new StaffService();
//# sourceMappingURL=staff.service.js.map
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = __importDefault(require("../config"));
const user_repository_1 = __importDefault(require("../repositories/user.repository"));
class AuthService {
    async login(email, password) {
        const normalizedEmail = email.toLowerCase();
        const user = await user_repository_1.default.findByEmail(normalizedEmail);
        if (!user || !user.isActive) {
            throw { status: 401, message: 'Invalid credentials', code: 'UNAUTHORIZED' };
        }
        const isPasswordValid = await bcrypt_1.default.compare(password, user.password);
        if (!isPasswordValid) {
            throw { status: 401, message: 'Invalid credentials', code: 'UNAUTHORIZED' };
        }
        const accessToken = this.generateAccessToken(user);
        const refreshToken = this.generateRefreshToken(user);
        const hashedRefreshToken = await bcrypt_1.default.hash(refreshToken, 10);
        await user_repository_1.default.updateRefreshToken(user.id, hashedRefreshToken);
        return {
            user: {
                id: user.id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                role: user.role.name,
            },
            tokens: {
                accessToken,
                refreshToken,
            },
        };
    }
    generateAccessToken(user) {
        return jsonwebtoken_1.default.sign({ id: user.id, email: user.email, role: user.role.name }, config_1.default.jwt.secret, { expiresIn: config_1.default.jwt.accessExpiration });
    }
    generateRefreshToken(user) {
        return jsonwebtoken_1.default.sign({ id: user.id }, config_1.default.jwt.refreshSecret, { expiresIn: config_1.default.jwt.refreshExpiration });
    }
    async refresh(token) {
        try {
            const decoded = jsonwebtoken_1.default.verify(token, config_1.default.jwt.refreshSecret);
            const user = await user_repository_1.default.findById(decoded.id);
            if (!user || !user.isActive || !user.refreshToken) {
                throw new Error();
            }
            const isRefreshTokenValid = await bcrypt_1.default.compare(token, user.refreshToken);
            if (!isRefreshTokenValid) {
                throw new Error();
            }
            const accessToken = this.generateAccessToken(user);
            return { accessToken };
        }
        catch (error) {
            throw { status: 401, message: 'Invalid refresh token', code: 'UNAUTHORIZED' };
        }
    }
    async logout(userId) {
        await user_repository_1.default.updateRefreshToken(userId, null);
    }
}
exports.AuthService = AuthService;
exports.default = new AuthService();

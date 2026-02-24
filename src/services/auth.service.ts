import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { StringValue } from 'ms';
import config from '../config';
import userRepository from '../repositories/user.repository';

export class AuthService {
    async login(email: string, password: string) {
        const user = await userRepository.findByEmail(email);

        if (!user || !user.isActive) {
            throw { status: 401, message: 'Invalid credentials', code: 'UNAUTHORIZED' };
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);

        if (!isPasswordValid) {
            throw { status: 401, message: 'Invalid credentials', code: 'UNAUTHORIZED' };
        }

        const accessToken = this.generateAccessToken(user);
        const refreshToken = this.generateRefreshToken(user);

        const hashedRefreshToken = await bcrypt.hash(refreshToken, 10);
        await userRepository.updateRefreshToken(user.id, hashedRefreshToken);

        return {
            user: {
                id: user.id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                role: (user as any).role.name,
            },
            tokens: {
                accessToken,
                refreshToken,
            },
        };
    }

    private generateAccessToken(user: any) {
        return jwt.sign(
            { id: user.id, email: user.email, role: user.role.name },
            config.jwt.secret,
            { expiresIn: config.jwt.accessExpiration as StringValue },
        );
    }

    private generateRefreshToken(user: any) {
        return jwt.sign(
            { id: user.id },
            config.jwt.refreshSecret,
            { expiresIn: config.jwt.refreshExpiration as StringValue },
        );
    }

    async refresh(token: string) {
        try {
            const decoded: any = jwt.verify(token, config.jwt.refreshSecret);
            const user = await userRepository.findById(decoded.id);

            if (!user || !user.isActive || !user.refreshToken) {
                throw new Error('User not found or inactive');
            }

            const isRefreshTokenValid = await bcrypt.compare(token, user.refreshToken);

            if (!isRefreshTokenValid) {
                throw new Error('Refresh token mismatch');
            }

            const accessToken = this.generateAccessToken(user);
            return { accessToken };
        } catch (error) {
            throw { status: 401, message: 'Invalid refresh token', code: 'UNAUTHORIZED' };
        }
    }

    async logout(userId: string) {
        await userRepository.updateRefreshToken(userId, null);
    }
}

export default new AuthService();

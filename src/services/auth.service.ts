import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import config from '../config';
import userRepository from '../repositories/user.repository';

export class AuthService {
    async login(email: string, password: string) {
        const normalizedEmail = email.toLowerCase();
        const user = await userRepository.findByEmail(normalizedEmail);

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
            config.jwt.secret as string,
            { expiresIn: config.jwt.accessExpiration as any },
        );
    }

    private generateRefreshToken(user: any) {
        return jwt.sign(
            { id: user.id },
            config.jwt.refreshSecret as string,
            { expiresIn: config.jwt.refreshExpiration as any },
        );
    }

    async refresh(token: string) {
        try {
            const decoded: any = jwt.verify(token, config.jwt.refreshSecret as string);
            const user = await userRepository.findById(decoded.id);

            if (!user || !user.isActive || !user.refreshToken) {
                throw new Error();
            }

            const isRefreshTokenValid = await bcrypt.compare(token, user.refreshToken);

            if (!isRefreshTokenValid) {
                throw new Error();
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

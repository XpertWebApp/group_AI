import { User, UserRole } from '@prisma/client';
export declare class UserRepository {
    findByEmail(email: string): Promise<User | null>;
    findById(id: string): Promise<User | null>;
    createRole(name: string, description?: string): Promise<UserRole>;
    createUser(data: any): Promise<User>;
    updateRefreshToken(userId: string, hashedToken: string | null): Promise<User>;
    updateGoogleTokens(userId: string, data: {
        googleAccessToken: string | null;
        googleRefreshToken: string | null;
        googleTokenExpiry: Date | null;
        googleEmail?: string | null;
    }): Promise<User>;
    getGoogleTokens(userId: string): Promise<{
        googleEmail: string | null;
        googleAccessToken: string | null;
        googleRefreshToken: string | null;
        googleTokenExpiry: Date | null;
    } | null>;
    clearGoogleTokens(userId: string): Promise<User>;
}
declare const _default: UserRepository;
export default _default;

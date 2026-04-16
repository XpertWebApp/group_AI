export declare class AuthService {
    login(email: string, password: string): Promise<{
        user: {
            id: string;
            email: string;
            firstName: string | null;
            lastName: string | null;
            role: any;
        };
        tokens: {
            accessToken: string;
            refreshToken: string;
        };
    }>;
    private generateAccessToken;
    private generateRefreshToken;
    refresh(token: string): Promise<{
        accessToken: string;
    }>;
    logout(userId: string): Promise<void>;
}
declare const _default: AuthService;
export default _default;

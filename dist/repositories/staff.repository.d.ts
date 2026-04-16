export interface StaffRow {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    isActive: boolean;
    lastLoginAt: Date | null;
    createdAt: Date;
    role: {
        name: string;
    };
}
export declare class StaffRepository {
    findAll(opts: {
        search?: string;
        status?: 'active' | 'blocked';
        page?: number;
        limit?: number;
    }): Promise<{
        data: StaffRow[];
        total: number;
        page: number;
        limit: number;
    }>;
    findById(id: string): Promise<StaffRow | null>;
    create(data: {
        email: string;
        password: string;
        firstName: string;
        lastName: string | null;
        roleId: string;
    }): Promise<StaffRow>;
    updateStatus(id: string, isActive: boolean): Promise<StaffRow>;
    updatePassword(id: string, hashedPassword: string): Promise<void>;
    delete(id: string): Promise<void>;
    getUserRole(): Promise<{
        id: string;
        name: string;
    }>;
    countAll(): Promise<number>;
}
declare const _default: StaffRepository;
export default _default;

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
export declare class StaffService {
    listStaff(opts: {
        search?: string;
        status?: 'active' | 'blocked';
        page?: number;
        limit?: number;
    }): Promise<{
        data: StaffListItem[];
        total: number;
        page: number;
        limit: number;
    }>;
    addStaff(input: {
        fullName: string;
        email: string;
    }, adminUserId: string): Promise<{
        email: string;
        oneTimePassword: string;
    }>;
    toggleStaffStatus(staffId: string, action: 'block' | 'unblock', adminUserId: string): Promise<StaffListItem>;
    resetPassword(staffId: string, adminUserId: string): Promise<{
        email: string;
        oneTimePassword: string;
    }>;
    deleteStaff(staffId: string, adminUserId: string): Promise<void>;
}
declare const _default: StaffService;
export default _default;

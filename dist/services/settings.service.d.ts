export declare class SettingsService {
    /**
     * Returns the settings overview for the main settings page (5 cards with last-updated timestamps).
     */
    getOverview(): Promise<{
        general: {
            updatedAt: Date | null;
        };
        supplierLimits: {
            updatedAt: Date | null;
        };
        email: {
            updatedAt: Date | null;
        };
        company: {
            updatedAt: Date | null;
        };
        policies: {
            updatedAt: Date | null;
        };
    }>;
    getGeneralConfig(): Promise<Record<string, string | null>>;
    updateGeneralConfig(data: {
        defaultMarkupPercentage: string;
    }): Promise<Record<string, string | null>>;
    getEmailConfig(): Promise<Record<string, string | null>>;
    updateEmailConfig(data: {
        smtpHost: string;
        smtpPort: string;
        smtpUsername: string;
        smtpPassword?: string;
        fromEmail: string;
        fromName: string;
    }): Promise<Record<string, string | null>>;
    getCompanyDetails(): Promise<Record<string, string | null>>;
    updateCompanyDetails(data: {
        companyName: string;
        assignedPerson: string;
        emailAddress: string;
        phoneNumber: string;
        phoneCountryCode?: string | null;
        website: string;
        taxId: string;
        address: string;
    }): Promise<Record<string, string | null>>;
    getPolicies(): Promise<Record<string, string | null>>;
    updatePolicies(data: {
        termsConditionsEn?: string;
        termsConditionsDe?: string;
        cancellationConditionsEn?: string;
        cancellationConditionsDe?: string;
    }): Promise<Record<string, string | null>>;
    getSupplierLimits(opts: {
        search?: string;
        page?: number;
        limit?: number;
    }): Promise<{
        data: import("../repositories/supplierLimits.repository").SupplierLimitRow[];
        total: number;
        page: number;
        limit: number;
    }>;
    updateSupplierLimit(supplierCode: string, data: {
        maxRooms?: number;
        groupsAllowed?: boolean;
        notes?: string;
    }): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        notes: string | null;
        supplierCode: string;
        providerName: string;
        accCode: string | null;
        maxRooms: number;
        groupsAllowed: boolean;
    }>;
}
declare const _default: SettingsService;
export default _default;

import { SettingCategory } from '@prisma/client';
import settingsRepository from '../repositories/settings.repository';
import supplierLimitsRepository from '../repositories/supplierLimits.repository';
import staffRepository from '../repositories/staff.repository';
import { refreshSupplierLimitsCache } from '../config/supplierLimits';
import gmailService from './gmail.service';

export class SettingsService {
    /**
     * Returns the settings overview for the main settings page (5 cards with last-updated timestamps).
     */
    async getOverview() {
        const [categoryTimestamps, supplierLimitsUpdated, staffCount] = await Promise.all([
            settingsRepository.getLastUpdatedByCategory(),
            supplierLimitsRepository.getLastUpdated(),
            staffRepository.countAll(),
        ]);

        return {
            general: { updatedAt: categoryTimestamps.general },
            supplierLimits: { updatedAt: supplierLimitsUpdated },
            email: { updatedAt: categoryTimestamps.email },
            company: { updatedAt: categoryTimestamps.company },
            policies: { updatedAt: categoryTimestamps.policies },
            staff: { totalStaff: staffCount },
        };
    }

    // ── General Configuration ────────────────────────────────────────────────

    async getGeneralConfig() {
        return settingsRepository.getByCategory(SettingCategory.general);
    }

    async updateGeneralConfig(data: { defaultMarkupPercentage: string }) {
        await settingsRepository.upsertMany(SettingCategory.general, {
            defaultMarkupPercentage: data.defaultMarkupPercentage,
        });
        return this.getGeneralConfig();
    }

    // ── Email Configuration (Google OAuth) ─────────────────────────────────────

    async getEmailConfig() {
        const [users, settings] = await Promise.all([
            gmailService.getAllConnectionStatuses(),
            settingsRepository.getByCategory(SettingCategory.email),
        ]);

        return {
            users,
            fromName: settings.fromName || null,
        };
    }

    async updateEmailConfig(data: { fromName: string }) {
        await settingsRepository.upsertMany(SettingCategory.email, {
            fromName: data.fromName,
        });
        return { fromName: data.fromName };
    }

    // ── Company Details ──────────────────────────────────────────────────────

    async getCompanyDetails() {
        return settingsRepository.getByCategory(SettingCategory.company);
    }

    async updateCompanyDetails(data: {
        companyName: string;
        assignedPerson: string;
        emailAddress: string;
        phoneNumber: string;
        website: string;
        taxId: string;
        address: string;
    }) {
        await settingsRepository.upsertMany(SettingCategory.company, data);
        return this.getCompanyDetails();
    }

    // ── Policies ─────────────────────────────────────────────────────────────

    async getPolicies() {
        return settingsRepository.getByCategory(SettingCategory.policies);
    }

    async updatePolicies(data: {
        termsConditionsEn?: string;
        termsConditionsDe?: string;
        cancellationConditionsEn?: string;
        cancellationConditionsDe?: string;
    }) {
        const updates: Record<string, string> = {};
        if (data.termsConditionsEn !== undefined) updates.termsConditionsEn = data.termsConditionsEn;
        if (data.termsConditionsDe !== undefined) updates.termsConditionsDe = data.termsConditionsDe;
        if (data.cancellationConditionsEn !== undefined) updates.cancellationConditionsEn = data.cancellationConditionsEn;
        if (data.cancellationConditionsDe !== undefined) updates.cancellationConditionsDe = data.cancellationConditionsDe;

        if (Object.keys(updates).length > 0) {
            await settingsRepository.upsertMany(SettingCategory.policies, updates);
        }
        return this.getPolicies();
    }

    // ── Supplier Limits ──────────────────────────────────────────────────────

    async getSupplierLimits(opts: { search?: string; page?: number; limit?: number }) {
        return supplierLimitsRepository.findAll(opts);
    }

    async updateSupplierLimit(supplierCode: string, data: { maxRooms?: number; groupsAllowed?: boolean; notes?: string }) {
        const existing = await supplierLimitsRepository.findByCode(supplierCode);
        if (!existing) {
            throw new Error(`Supplier limit not found for code: ${supplierCode}`);
        }
        const result = await supplierLimitsRepository.update(supplierCode, data);
        // Refresh the in-memory cache so hotelSearch picks up changes immediately
        await refreshSupplierLimitsCache();
        return result;
    }
}

export default new SettingsService();

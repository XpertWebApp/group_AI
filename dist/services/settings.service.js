"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsService = void 0;
const client_1 = require("@prisma/client");
const settings_repository_1 = __importDefault(require("../repositories/settings.repository"));
const supplierLimits_repository_1 = __importDefault(require("../repositories/supplierLimits.repository"));
const supplierLimits_1 = require("../config/supplierLimits");
class SettingsService {
    /**
     * Returns the settings overview for the main settings page (5 cards with last-updated timestamps).
     */
    async getOverview() {
        const [categoryTimestamps, supplierLimitsUpdated] = await Promise.all([
            settings_repository_1.default.getLastUpdatedByCategory(),
            supplierLimits_repository_1.default.getLastUpdated(),
        ]);
        return {
            general: { updatedAt: categoryTimestamps.general },
            supplierLimits: { updatedAt: supplierLimitsUpdated },
            email: { updatedAt: categoryTimestamps.email },
            company: { updatedAt: categoryTimestamps.company },
            policies: { updatedAt: categoryTimestamps.policies },
        };
    }
    // ── General Configuration ────────────────────────────────────────────────
    async getGeneralConfig() {
        return settings_repository_1.default.getByCategory(client_1.SettingCategory.general);
    }
    async updateGeneralConfig(data) {
        await settings_repository_1.default.upsertMany(client_1.SettingCategory.general, {
            defaultMarkupPercentage: data.defaultMarkupPercentage,
        });
        return this.getGeneralConfig();
    }
    // ── Email Configuration ──────────────────────────────────────────────────
    async getEmailConfig() {
        const settings = await settings_repository_1.default.getByCategory(client_1.SettingCategory.email);
        // Mask the password for read responses
        if (settings.smtpPassword) {
            settings.smtpPassword = '••••••••••••';
        }
        return settings;
    }
    async updateEmailConfig(data) {
        const updates = {
            smtpHost: data.smtpHost,
            smtpPort: data.smtpPort,
            smtpUsername: data.smtpUsername,
            fromEmail: data.fromEmail,
            fromName: data.fromName,
        };
        // Only update password if a new one is provided (not the masked placeholder)
        if (data.smtpPassword && data.smtpPassword !== '••••••••••••') {
            updates.smtpPassword = data.smtpPassword;
        }
        await settings_repository_1.default.upsertMany(client_1.SettingCategory.email, updates);
        return this.getEmailConfig();
    }
    // ── Company Details ──────────────────────────────────────────────────────
    async getCompanyDetails() {
        return settings_repository_1.default.getByCategory(client_1.SettingCategory.company);
    }
    async updateCompanyDetails(data) {
        // Filter out undefined values — settingsRepository expects Record<string, string>
        const cleaned = {};
        for (const [key, value] of Object.entries(data)) {
            if (value !== undefined && value !== null) {
                cleaned[key] = String(value);
            }
        }
        await settings_repository_1.default.upsertMany(client_1.SettingCategory.company, cleaned);
        return this.getCompanyDetails();
    }
    // ── Policies ─────────────────────────────────────────────────────────────
    async getPolicies() {
        return settings_repository_1.default.getByCategory(client_1.SettingCategory.policies);
    }
    async updatePolicies(data) {
        const updates = {};
        if (data.termsConditionsEn !== undefined)
            updates.termsConditionsEn = data.termsConditionsEn;
        if (data.termsConditionsDe !== undefined)
            updates.termsConditionsDe = data.termsConditionsDe;
        if (data.cancellationConditionsEn !== undefined)
            updates.cancellationConditionsEn = data.cancellationConditionsEn;
        if (data.cancellationConditionsDe !== undefined)
            updates.cancellationConditionsDe = data.cancellationConditionsDe;
        if (Object.keys(updates).length > 0) {
            await settings_repository_1.default.upsertMany(client_1.SettingCategory.policies, updates);
        }
        return this.getPolicies();
    }
    // ── Supplier Limits ──────────────────────────────────────────────────────
    async getSupplierLimits(opts) {
        return supplierLimits_repository_1.default.findAll(opts);
    }
    async updateSupplierLimit(supplierCode, data) {
        const existing = await supplierLimits_repository_1.default.findByCode(supplierCode);
        if (!existing) {
            throw new Error(`Supplier limit not found for code: ${supplierCode}`);
        }
        const result = await supplierLimits_repository_1.default.update(supplierCode, data);
        // Refresh the in-memory cache so hotelSearch picks up changes immediately
        await (0, supplierLimits_1.refreshSupplierLimitsCache)();
        return result;
    }
}
exports.SettingsService = SettingsService;
exports.default = new SettingsService();

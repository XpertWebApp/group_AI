"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsController = void 0;
const settings_service_1 = __importDefault(require("../services/settings.service"));
const response_1 = require("../utils/response");
class SettingsController {
    /**
     * GET /api/v1/settings
     * Returns the settings overview (5 cards with last-updated timestamps).
     */
    async overview(req, res, next) {
        try {
            const result = await settings_service_1.default.getOverview();
            return (0, response_1.sendResponse)(res, 200, result, 'Settings overview retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    // ── General Configuration ────────────────────────────────────────────────
    /**
     * GET /api/v1/settings/general
     */
    async getGeneralConfig(req, res, next) {
        try {
            const result = await settings_service_1.default.getGeneralConfig();
            return (0, response_1.sendResponse)(res, 200, result, 'General configuration retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * PUT /api/v1/settings/general
     */
    async updateGeneralConfig(req, res, next) {
        try {
            const data = req.validated.body;
            const result = await settings_service_1.default.updateGeneralConfig(data);
            return (0, response_1.sendResponse)(res, 200, result, 'General configuration updated');
        }
        catch (error) {
            next(error);
        }
    }
    // ── Email Configuration ──────────────────────────────────────────────────
    /**
     * GET /api/v1/settings/email
     */
    async getEmailConfig(req, res, next) {
        try {
            const result = await settings_service_1.default.getEmailConfig();
            return (0, response_1.sendResponse)(res, 200, result, 'Email configuration retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * PUT /api/v1/settings/email
     */
    async updateEmailConfig(req, res, next) {
        try {
            const data = req.validated.body;
            const result = await settings_service_1.default.updateEmailConfig(data);
            return (0, response_1.sendResponse)(res, 200, result, 'Email configuration updated');
        }
        catch (error) {
            next(error);
        }
    }
    // ── Company Details ──────────────────────────────────────────────────────
    /**
     * GET /api/v1/settings/company
     */
    async getCompanyDetails(req, res, next) {
        try {
            const result = await settings_service_1.default.getCompanyDetails();
            return (0, response_1.sendResponse)(res, 200, result, 'Company details retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * PUT /api/v1/settings/company
     */
    async updateCompanyDetails(req, res, next) {
        try {
            const data = req.validated.body;
            const result = await settings_service_1.default.updateCompanyDetails(data);
            return (0, response_1.sendResponse)(res, 200, result, 'Company details updated');
        }
        catch (error) {
            next(error);
        }
    }
    // ── Policies ─────────────────────────────────────────────────────────────
    /**
     * GET /api/v1/settings/policies
     */
    async getPolicies(req, res, next) {
        try {
            const result = await settings_service_1.default.getPolicies();
            return (0, response_1.sendResponse)(res, 200, result, 'Policies retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * PUT /api/v1/settings/policies
     */
    async updatePolicies(req, res, next) {
        try {
            const data = req.validated.body;
            const result = await settings_service_1.default.updatePolicies(data);
            return (0, response_1.sendResponse)(res, 200, result, 'Policies updated');
        }
        catch (error) {
            next(error);
        }
    }
    // ── Supplier Limits ──────────────────────────────────────────────────────
    /**
     * GET /api/v1/settings/supplier-limits
     */
    async getSupplierLimits(req, res, next) {
        try {
            const query = req.validated?.query ?? req.query;
            const result = await settings_service_1.default.getSupplierLimits({
                search: query.search,
                page: query.page,
                limit: query.limit,
            });
            return (0, response_1.sendResponse)(res, 200, result, 'Supplier limits retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    /**
     * PATCH /api/v1/settings/supplier-limits/:supplierCode
     */
    async updateSupplierLimit(req, res, next) {
        try {
            const { supplierCode } = req.params;
            const data = req.validated.body;
            const result = await settings_service_1.default.updateSupplierLimit(supplierCode, data);
            return (0, response_1.sendResponse)(res, 200, result, 'Supplier limit updated');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.SettingsController = SettingsController;
exports.default = new SettingsController();

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StaffController = void 0;
const staff_service_1 = __importDefault(require("../services/staff.service"));
const response_1 = require("../utils/response");
class StaffController {
    /** GET /api/v1/settings/staff */
    async list(req, res, next) {
        try {
            const query = req.validated?.query ?? req.query;
            const result = await staff_service_1.default.listStaff({
                search: query.search,
                status: query.status,
                page: query.page,
                limit: query.limit,
            });
            return (0, response_1.sendResponse)(res, 200, result, 'Staff list retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    /** POST /api/v1/settings/staff */
    async add(req, res, next) {
        try {
            const data = req.validated.body;
            const adminUserId = req.user.id;
            const result = await staff_service_1.default.addStaff(data, adminUserId);
            return (0, response_1.sendResponse)(res, 201, result, 'Staff added successfully');
        }
        catch (error) {
            next(error);
        }
    }
    /** PATCH /api/v1/settings/staff/:id/status */
    async toggleStatus(req, res, next) {
        try {
            const id = req.params.id;
            const { action } = req.validated.body;
            const adminUserId = req.user.id;
            const result = await staff_service_1.default.toggleStaffStatus(id, action, adminUserId);
            const message = action === 'block' ? 'Staff member blocked' : 'Staff member unblocked';
            return (0, response_1.sendResponse)(res, 200, result, message);
        }
        catch (error) {
            next(error);
        }
    }
    /** POST /api/v1/settings/staff/:id/reset-password */
    async resetPassword(req, res, next) {
        try {
            const id = req.params.id;
            const adminUserId = req.user.id;
            const result = await staff_service_1.default.resetPassword(id, adminUserId);
            return (0, response_1.sendResponse)(res, 200, result, 'Password reset successfully');
        }
        catch (error) {
            next(error);
        }
    }
    /** DELETE /api/v1/settings/staff/:id */
    async delete(req, res, next) {
        try {
            const id = req.params.id;
            const adminUserId = req.user.id;
            await staff_service_1.default.deleteStaff(id, adminUserId);
            return (0, response_1.sendResponse)(res, 200, null, 'Staff member deleted');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.StaffController = StaffController;
exports.default = new StaffController();
//# sourceMappingURL=staff.controller.js.map
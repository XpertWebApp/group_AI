"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const auth_service_1 = __importDefault(require("../services/auth.service"));
const response_1 = require("../utils/response");
class AuthController {
    async login(req, res, next) {
        try {
            const { email, password } = req.body;
            const result = await auth_service_1.default.login(email, password);
            return (0, response_1.sendResponse)(res, 200, result, 'Login successful');
        }
        catch (error) {
            next(error);
        }
    }
    async refresh(req, res, next) {
        try {
            const { refreshToken } = req.body;
            const result = await auth_service_1.default.refresh(refreshToken);
            return (0, response_1.sendResponse)(res, 200, result, 'Token refreshed');
        }
        catch (error) {
            next(error);
        }
    }
    async logout(req, res, next) {
        try {
            const user = req.user;
            if (user && user.id) {
                await auth_service_1.default.logout(user.id);
            }
            return (0, response_1.sendResponse)(res, 200, null, 'Logout successful');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.AuthController = AuthController;
exports.default = new AuthController();

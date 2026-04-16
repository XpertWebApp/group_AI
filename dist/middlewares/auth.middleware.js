"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = __importDefault(require("../config"));
const response_1 = require("../utils/response");
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return (0, response_1.sendResponse)(res, 401, null, 'No token provided', 'UNAUTHORIZED');
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jsonwebtoken_1.default.verify(token, config_1.default.jwt.secret);
        req.user = decoded;
        next();
    }
    catch (error) {
        return (0, response_1.sendResponse)(res, 401, null, 'Invalid or expired token', 'UNAUTHORIZED');
    }
};
exports.authMiddleware = authMiddleware;

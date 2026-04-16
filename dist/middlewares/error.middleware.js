"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorMiddleware = void 0;
const logger_1 = __importDefault(require("../utils/logger"));
const response_1 = require("../utils/response");
const errorMiddleware = (err, req, res, _next) => {
    const statusCode = err.status || err.statusCode || 500;
    const message = err.message || 'Internal Server Error';
    const errorCode = err.code || 'INTERNAL_ERROR';
    logger_1.default.error({
        msg: message,
        stack: err.stack,
        path: req.path,
        method: req.method,
        errorCode,
    });
    return (0, response_1.sendResponse)(res, statusCode, null, message, errorCode);
};
exports.errorMiddleware = errorMiddleware;

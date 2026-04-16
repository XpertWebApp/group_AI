"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendResponse = void 0;
const sendResponse = (res, statusCode, data = null, message = 'Success', error = null) => {
    const response = {
        success: statusCode >= 200 && statusCode < 300,
        data,
        message,
    };
    if (error) {
        response.error = error;
    }
    return res.status(statusCode).json(response);
};
exports.sendResponse = sendResponse;

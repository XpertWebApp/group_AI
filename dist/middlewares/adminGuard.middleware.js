"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminGuard = void 0;
const response_1 = require("../utils/response");
const adminGuard = (req, res, next) => {
    const user = req.user;
    if (!user || user.role !== 'ADMIN') {
        return (0, response_1.sendResponse)(res, 403, null, 'Admin access required', 'FORBIDDEN');
    }
    next();
};
exports.adminGuard = adminGuard;
//# sourceMappingURL=adminGuard.middleware.js.map
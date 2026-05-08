"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const destination_repository_1 = __importDefault(require("../repositories/destination.repository"));
const auth_middleware_1 = require("../middlewares/auth.middleware");
const response_1 = require("../utils/response");
const router = (0, express_1.Router)();
/**
 * GET /api/v1/destinations/search?q=Barcelona&limit=10
 *
 * Search destinations by name (used by the frontend Create Request form
 * to resolve a city name to its correct destinationId before submitting).
 *
 * Results are ranked by hotel inventory (most-bookable first), with secondary
 * tie-breaks on match quality (startsWith above contains) and name length.
 * Zero-inventory destinations remain visible but always sort to the bottom.
 */
router.get('/search', auth_middleware_1.authMiddleware, async (req, res, next) => {
    try {
        const q = String(req.query.q ?? '').trim();
        const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10), 50);
        if (q.length < 2) {
            return (0, response_1.sendResponse)(res, 200, [], 'Query too short');
        }
        const results = await destination_repository_1.default.searchByName(q, limit);
        return (0, response_1.sendResponse)(res, 200, results, 'Destinations retrieved');
    }
    catch (err) {
        next(err);
    }
});
exports.default = router;

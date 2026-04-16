"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const response_1 = require("../utils/response");
const router = (0, express_1.Router)();
const prisma = new client_1.PrismaClient();
/**
 * GET /api/v1/destinations/search?q=Barcelona&limit=10
 *
 * Search destinations by name (used by the frontend Create Request form
 * to resolve a city name to its correct destinationId before submitting).
 *
 * Returns top matches ordered by name length (shorter = more exact match first).
 */
router.get('/search', auth_middleware_1.authMiddleware, async (req, res, next) => {
    try {
        const q = String(req.query.q ?? '').trim();
        const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10), 50);
        if (q.length < 2) {
            return (0, response_1.sendResponse)(res, 200, [], 'Query too short');
        }
        const results = await prisma.destination.findMany({
            where: {
                name: { contains: q, mode: 'insensitive' },
            },
            select: {
                id: true,
                name: true,
                countryCode: true,
                region: true,
            },
            orderBy: { name: 'asc' },
            take: limit * 3, // fetch extra, then sort by match quality client-side
        });
        // Prioritise exact-start matches and shorter names (more specific city)
        const sorted = results.sort((a, b) => {
            const aStarts = a.name.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1;
            const bStarts = b.name.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1;
            if (aStarts !== bStarts)
                return aStarts - bStarts;
            return a.name.length - b.name.length;
        });
        return (0, response_1.sendResponse)(res, 200, sorted.slice(0, limit), 'Destinations retrieved');
    }
    catch (err) {
        next(err);
    }
});
exports.default = router;

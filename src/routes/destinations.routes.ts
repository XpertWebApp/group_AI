import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middlewares/auth.middleware';
import { sendResponse } from '../utils/response';

const router = Router();
const prisma = new PrismaClient();

/**
 * GET /api/v1/destinations/search?q=Barcelona&limit=10
 *
 * Search destinations by name (used by the frontend Create Request form
 * to resolve a city name to its correct destinationId before submitting).
 *
 * Returns top matches ordered by name length (shorter = more exact match first).
 */
router.get('/search', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const q = String(req.query.q ?? '').trim();
        const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10), 50);

        if (q.length < 2) {
            return sendResponse(res, 200, [], 'Query too short');
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
            if (aStarts !== bStarts) return aStarts - bStarts;
            return a.name.length - b.name.length;
        });

        return sendResponse(res, 200, sorted.slice(0, limit), 'Destinations retrieved');
    } catch (err) {
        next(err);
    }
});

export default router;

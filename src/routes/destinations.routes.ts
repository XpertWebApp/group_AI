import { Router, Request, Response, NextFunction } from 'express';
import destinationRepository from '../repositories/destination.repository';
import { authMiddleware } from '../middlewares/auth.middleware';
import { sendResponse } from '../utils/response';

const router = Router();

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
router.get('/search', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const q = String(req.query.q ?? '').trim();
        const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10), 50);

        if (q.length < 2) {
            return sendResponse(res, 200, [], 'Query too short');
        }

        const results = await destinationRepository.searchByName(q, limit);
        return sendResponse(res, 200, results, 'Destinations retrieved');
    } catch (err) {
        next(err);
    }
});

export default router;

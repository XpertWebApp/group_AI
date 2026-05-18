import { Router, Request, Response, NextFunction } from 'express';
import hotelController from '../controllers/hotel.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import { HotelSearchQuerySchema } from '../validation/requestSchemas';
import rateLimit from 'express-rate-limit';
import wbeClientService from '../services/wbe.client.service';
import giataClientService from '../services/giata.client.service';
import hotelSearchRepository from '../repositories/hotelSearch.repository';
import { sendResponse } from '../utils/response';

const router = Router();

const searchLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 min
    max: 60,
    message: { error: { code: 'rate_limited', message: 'Too many requests, try again later' } },
});

const imageLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    message: { error: { code: 'rate_limited', message: 'Too many requests, try again later' } },
});

router.get(
    '/search',
    authMiddleware,
    searchLimiter,
    validate(HotelSearchQuerySchema, 'query'),
    hotelController.search,
);

/**
 * GET /api/v1/hotels/facilities
 *
 * Returns all master facilities (amenities) for filter sidebar.
 */
router.get('/facilities', authMiddleware, searchLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const facilities = await hotelSearchRepository.getAllFacilities();
        return sendResponse(res, 200, { facilities }, 'Facilities retrieved');
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/hotels/facilities/by-destination/:destinationId
 *
 * Returns facilities available for hotels in a specific destination,
 * along with a count of how many hotels have each facility.
 */
router.get('/facilities/by-destination/:destinationId', authMiddleware, searchLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const destinationId = parseInt(req.params['destinationId'] as string, 10);
        if (isNaN(destinationId)) {
            res.status(400).json({ error: { code: 'bad_request', message: 'Invalid destinationId' } });
            return;
        }
        const facilities = await hotelSearchRepository.getFacilitiesByDestination(destinationId);
        return sendResponse(res, 200, { facilities }, 'Facilities for destination retrieved');
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/hotels/image?key={imageKey}
 *
 * Server-side proxy for WBE hotel images.
 * Accepts the imageKey token (URL-encoded) and fetches the image from WBE,
 * forwarding it to the client. Returns 404 if the image is unavailable.
 *
 * No auth required — imageKey is itself a scoped token.
 */
router.get('/image', imageLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const key = String(req.query.key ?? '').trim();
        if (!key) {
            res.status(400).json({ error: { code: 'bad_request', message: 'key parameter is required' } });
            return;
        }

        const result = await wbeClientService.getHotelImage(key);
        if (!result) {
            res.status(404).json({ error: { code: 'not_found', message: 'Image not available' } });
            return;
        }

        res.set('Content-Type', result.contentType);
        res.set('Cache-Control', 'public, max-age=86400'); // cache 24h
        res.send(result.data);
    } catch (err) {
        next(err);
    }
});

/**
 * Server-side proxy for GIATA hotel images.
 * GIATA's image URLs (ghgml.giatamedia.com) require HTTP Basic Auth, so the
 * browser can't fetch them directly. This endpoint authenticates via the
 * backend and streams the bytes back.
 *
 * Only the GIATA media host is allowed (SSRF guard in giataClientService.fetchImage).
 * No auth required on our side — these are already-public hotel photos.
 */
router.get('/giata-image', imageLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const url = String(req.query.url ?? '').trim();
        if (!url) {
            res.status(400).json({ error: { code: 'bad_request', message: 'url parameter is required' } });
            return;
        }

        const result = await giataClientService.fetchImage(url);
        if (!result) {
            res.status(404).json({ error: { code: 'not_found', message: 'GIATA image not available' } });
            return;
        }

        res.set('Content-Type', result.contentType);
        res.set('Cache-Control', 'public, max-age=604800'); // cache 7d (GIATA images are stable)
        res.send(result.data);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/v1/hotels/details?code={hotelCode}
 *
 * Returns full hotel details (description, all images, facilities, contact info).
 * Data is sourced from the metadata JSON column (synced from WBE CDN).
 * Uses query param instead of path param because hotelCode contains "/" and "=" characters.
 */
router.get('/details', authMiddleware, searchLimiter, hotelController.getDetails);

export default router;

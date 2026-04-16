"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const hotel_controller_1 = __importDefault(require("../controllers/hotel.controller"));
const auth_middleware_1 = require("../middlewares/auth.middleware");
const validate_middleware_1 = require("../middlewares/validate.middleware");
const requestSchemas_1 = require("../validation/requestSchemas");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const wbe_client_service_1 = __importDefault(require("../services/wbe.client.service"));
const hotelSearch_repository_1 = __importDefault(require("../repositories/hotelSearch.repository"));
const response_1 = require("../utils/response");
const router = (0, express_1.Router)();
const searchLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000, // 1 min
    max: 60,
    message: { error: { code: 'rate_limited', message: 'Too many requests, try again later' } },
});
const imageLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 300,
    message: { error: { code: 'rate_limited', message: 'Too many requests, try again later' } },
});
router.get('/search', auth_middleware_1.authMiddleware, searchLimiter, (0, validate_middleware_1.validate)(requestSchemas_1.HotelSearchQuerySchema, 'query'), hotel_controller_1.default.search);
/**
 * GET /api/v1/hotels/facilities
 *
 * Returns all master facilities (amenities) for filter sidebar.
 */
router.get('/facilities', auth_middleware_1.authMiddleware, searchLimiter, async (req, res, next) => {
    try {
        const facilities = await hotelSearch_repository_1.default.getAllFacilities();
        return (0, response_1.sendResponse)(res, 200, { facilities }, 'Facilities retrieved');
    }
    catch (err) {
        next(err);
    }
});
/**
 * GET /api/v1/hotels/facilities/by-destination/:destinationId
 *
 * Returns facilities available for hotels in a specific destination,
 * along with a count of how many hotels have each facility.
 */
router.get('/facilities/by-destination/:destinationId', auth_middleware_1.authMiddleware, searchLimiter, async (req, res, next) => {
    try {
        const destinationId = parseInt(req.params['destinationId'], 10);
        if (isNaN(destinationId)) {
            res.status(400).json({ error: { code: 'bad_request', message: 'Invalid destinationId' } });
            return;
        }
        const facilities = await hotelSearch_repository_1.default.getFacilitiesByDestination(destinationId);
        return (0, response_1.sendResponse)(res, 200, { facilities }, 'Facilities for destination retrieved');
    }
    catch (err) {
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
router.get('/image', imageLimiter, async (req, res, next) => {
    try {
        const key = String(req.query.key ?? '').trim();
        if (!key) {
            res.status(400).json({ error: { code: 'bad_request', message: 'key parameter is required' } });
            return;
        }
        const result = await wbe_client_service_1.default.getHotelImage(key);
        if (!result) {
            res.status(404).json({ error: { code: 'not_found', message: 'Image not available' } });
            return;
        }
        res.set('Content-Type', result.contentType);
        res.set('Cache-Control', 'public, max-age=86400'); // cache 24h
        res.send(result.data);
    }
    catch (err) {
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
router.get('/details', auth_middleware_1.authMiddleware, searchLimiter, hotel_controller_1.default.getDetails);
exports.default = router;

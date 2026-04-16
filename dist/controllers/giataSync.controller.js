"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GiataSyncController = void 0;
const client_1 = require("@prisma/client");
const giataSync_service_1 = __importDefault(require("../services/giataSync.service"));
const giata_repository_1 = __importDefault(require("../repositories/giata.repository"));
const response_1 = require("../utils/response");
const prisma = new client_1.PrismaClient();
class GiataSyncController {
    /** POST /api/v1/settings/giata/sync — trigger full GIATA sync */
    async triggerFullSync(req, res, next) {
        try {
            // Run async — don't block the HTTP response
            giataSync_service_1.default.fullSync().catch((err) => {
                console.error('GIATA full sync background error:', err.message);
            });
            return (0, response_1.sendResponse)(res, 202, { message: 'Full GIATA sync started in background' }, 'Sync triggered');
        }
        catch (error) {
            next(error);
        }
    }
    /** POST /api/v1/settings/giata/sync/incremental — trigger incremental sync */
    async triggerIncrementalSync(req, res, next) {
        try {
            giataSync_service_1.default.incrementalSync().catch((err) => {
                console.error('GIATA incremental sync background error:', err.message);
            });
            return (0, response_1.sendResponse)(res, 202, { message: 'Incremental GIATA sync started in background' }, 'Sync triggered');
        }
        catch (error) {
            next(error);
        }
    }
    /** POST /api/v1/settings/giata/sync/:hotelCode — sync a single hotel */
    async syncSingleHotel(req, res, next) {
        try {
            // Accept hotelCode from query param OR body (no route param — base64 chars break URLs)
            const hotelCode = req.query.hotelCode
                || req.body?.hotelCode;
            if (!hotelCode) {
                return (0, response_1.sendResponse)(res, 400, null, 'hotelCode is required (as route param, query param, or body)');
            }
            console.log(`[GIATA] Single hotel sync requested for: "${hotelCode}"`);
            // Direct DB lookup
            const hotel = await prisma.hotel.findUnique({
                where: { hotelCode },
                select: { hotelCode: true, giataCode: true, name: true },
            });
            if (!hotel || !hotel.giataCode) {
                // Also try by giataCode in case the user passed the GIATA ID instead
                const byGiata = await prisma.hotel.findFirst({
                    where: { giataCode: hotelCode },
                    select: { hotelCode: true, giataCode: true, name: true },
                });
                if (byGiata?.giataCode) {
                    const success = await giataSync_service_1.default.syncHotel(byGiata.hotelCode, byGiata.giataCode);
                    return (0, response_1.sendResponse)(res, 200, { success, hotelCode: byGiata.hotelCode, giataCode: byGiata.giataCode, name: byGiata.name }, 'Hotel GIATA sync completed');
                }
                return (0, response_1.sendResponse)(res, 404, null, `Hotel not found or has no GIATA code. Received: "${hotelCode}"`);
            }
            const success = await giataSync_service_1.default.syncHotel(hotelCode, hotel.giataCode);
            return (0, response_1.sendResponse)(res, 200, { success, hotelCode, giataCode: hotel.giataCode }, 'Hotel GIATA sync completed');
        }
        catch (error) {
            next(error);
        }
    }
    /** GET /api/v1/settings/giata/status — sync status overview */
    async getStatus(req, res, next) {
        try {
            const status = await giataSync_service_1.default.getStatus();
            return (0, response_1.sendResponse)(res, 200, status, 'GIATA sync status retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    /** GET /api/v1/settings/giata/missing — hotels without GIATA data */
    async getMissingHotels(req, res, next) {
        try {
            const missing = await giata_repository_1.default.getHotelsWithoutGiataCode({ limit: 100 });
            return (0, response_1.sendResponse)(res, 200, { hotels: missing, count: missing.length }, 'Missing GIATA hotels retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    /** POST /api/v1/settings/giata/resolve — resolve missing GIATA codes via Multicodes */
    async resolveGiataCodes(req, res, next) {
        try {
            giataSync_service_1.default.resolveMissingGiataCodes().catch((err) => {
                console.error('GIATA resolve background error:', err.message);
            });
            return (0, response_1.sendResponse)(res, 202, { message: 'GIATA code resolution started in background' }, 'Resolution triggered');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.GiataSyncController = GiataSyncController;
exports.default = new GiataSyncController();

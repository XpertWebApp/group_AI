import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import giataSyncService from '../services/giataSync.service';
import giataRepository from '../repositories/giata.repository';
import { sendResponse } from '../utils/response';

const prisma = new PrismaClient();

export class GiataSyncController {
    /** POST /api/v1/settings/giata/sync — trigger full GIATA sync */
    async triggerFullSync(req: Request, res: Response, next: NextFunction) {
        try {
            // Run async — don't block the HTTP response
            giataSyncService.fullSync().catch((err) => {
                console.error('GIATA full sync background error:', err.message);
            });
            return sendResponse(res, 202, { message: 'Full GIATA sync started in background' }, 'Sync triggered');
        } catch (error) {
            next(error);
        }
    }

    /** POST /api/v1/settings/giata/sync/incremental — trigger incremental sync */
    async triggerIncrementalSync(req: Request, res: Response, next: NextFunction) {
        try {
            giataSyncService.incrementalSync().catch((err) => {
                console.error('GIATA incremental sync background error:', err.message);
            });
            return sendResponse(res, 202, { message: 'Incremental GIATA sync started in background' }, 'Sync triggered');
        } catch (error) {
            next(error);
        }
    }

    /** POST /api/v1/settings/giata/sync/:hotelCode — sync a single hotel */
    async syncSingleHotel(req: Request, res: Response, next: NextFunction) {
        try {
            // Accept hotelCode from query param OR body (no route param — base64 chars break URLs)
            const hotelCode = (req.query.hotelCode as string)
                || (req.body?.hotelCode as string);

            if (!hotelCode) {
                return sendResponse(res, 400, null, 'hotelCode is required (as route param, query param, or body)');
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
                    const success = await giataSyncService.syncHotel(byGiata.hotelCode, byGiata.giataCode);
                    return sendResponse(res, 200, { success, hotelCode: byGiata.hotelCode, giataCode: byGiata.giataCode, name: byGiata.name }, 'Hotel GIATA sync completed');
                }
                return sendResponse(res, 404, null, `Hotel not found or has no GIATA code. Received: "${hotelCode}"`);
            }

            const success = await giataSyncService.syncHotel(hotelCode, hotel.giataCode);
            return sendResponse(res, 200, { success, hotelCode, giataCode: hotel.giataCode }, 'Hotel GIATA sync completed');
        } catch (error) {
            next(error);
        }
    }

    /** GET /api/v1/settings/giata/status — sync status overview */
    async getStatus(req: Request, res: Response, next: NextFunction) {
        try {
            const status = await giataSyncService.getStatus();
            return sendResponse(res, 200, status, 'GIATA sync status retrieved');
        } catch (error) {
            next(error);
        }
    }

    /** GET /api/v1/settings/giata/missing — hotels without GIATA data */
    async getMissingHotels(req: Request, res: Response, next: NextFunction) {
        try {
            const missing = await giataRepository.getHotelsWithoutGiataCode({ limit: 100 });
            return sendResponse(res, 200, { hotels: missing, count: missing.length }, 'Missing GIATA hotels retrieved');
        } catch (error) {
            next(error);
        }
    }

    /** POST /api/v1/settings/giata/resolve — resolve missing GIATA codes via Multicodes */
    async resolveGiataCodes(req: Request, res: Response, next: NextFunction) {
        try {
            giataSyncService.resolveMissingGiataCodes().catch((err) => {
                console.error('GIATA resolve background error:', err.message);
            });
            return sendResponse(res, 202, { message: 'GIATA code resolution started in background' }, 'Resolution triggered');
        } catch (error) {
            next(error);
        }
    }
}

export default new GiataSyncController();

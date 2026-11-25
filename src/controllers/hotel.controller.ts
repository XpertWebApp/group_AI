import { Request, Response, NextFunction } from 'express';
import hotelService from '../services/hotel.service';
import { sendResponse } from '../utils/response';
import { normaliseLang } from '../utils/hotelDescription';

export class HotelController {
    async search(req: Request, res: Response, next: NextFunction) {
        try {
            const query = (req as any).validated?.query ?? req.query;
            const result = await hotelService.searchHotels({
                q: query.q as string | undefined,
                destinationId: query.destinationId as number | undefined,
                starRating: query.starRating as number | undefined,
                limit: query.limit as number | undefined,
                offset: query.offset as number | undefined,
            });
            return sendResponse(res, 200, result, 'Hotels retrieved');
        } catch (error) {
            next(error);
        }
    }

    async getDetails(req: Request, res: Response, next: NextFunction) {
        try {
            const hotelCode = (req.query.code as string ?? '').trim();
            if (!hotelCode) {
                return sendResponse(res, 400, null, 'code query parameter is required', 'BAD_REQUEST');
            }
            const lang = normaliseLang(req.query.lang);
            const result = await hotelService.getHotelDetails(hotelCode, lang);
            return sendResponse(res, 200, result, 'Hotel details retrieved');
        } catch (error) {
            next(error);
        }
    }
}

export default new HotelController();

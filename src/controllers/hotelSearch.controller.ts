import { Request, Response, NextFunction } from 'express';
import hotelSearchService from '../services/hotelSearch.service';
import { sendResponse } from '../utils/response';

export class HotelSearchController {
    /**
     * POST /api/v1/requests/:id/hotel-search
     *
     * Triggers the full hotel search orchestration for a booking request.
     * Steps 1-6 from the SETT Phase 1 guide.
     */
    async search(req: Request, res: Response, next: NextFunction) {
        try {
            const requestId = req.params['id'] as string;
            const body = (req as any).validated?.body ?? req.body;

            const result = await hotelSearchService.searchForRequest(requestId, {
                mealType: body.mealType,
                includeAlternativeStars: body.includeAlternativeStars,
                waitSeconds: body.waitSeconds,
                currencyCode: body.currencyCode,
                nationalityCode: body.nationalityCode,
            });

            return sendResponse(res, 200, result, 'Hotel search completed');
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/v1/requests/:id/hotel-search/option-details
     *
     * Fetches and caches OptionDetailsV2 for selected TIDs.
     * Step 6 from the SETT Phase 1 guide (exact per-night pricing + cancellation policy).
     */
    async optionDetails(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;

            const result = await hotelSearchService.fetchOptionDetails(body.selections);

            return sendResponse(res, 200, result, 'Option details retrieved');
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/v1/requests/:id/hotel-search/calculate-price
     *
     * Calculates the recommended customer sell price for a given buying price + markup.
     * Step 7 from the SETT Phase 1 guide.
     */
    async calculatePrice(req: Request, res: Response, next: NextFunction) {
        try {
            const body = (req as any).validated?.body ?? req.body;
            const { buyingPrice, markupPercent } = body;

            const result = hotelSearchService.calculateSellPrice(buyingPrice, markupPercent);

            return sendResponse(res, 200, result, 'Price calculated');
        } catch (error) {
            next(error);
        }
    }
}

export default new HotelSearchController();

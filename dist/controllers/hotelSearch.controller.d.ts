import { Request, Response, NextFunction } from 'express';
export declare class HotelSearchController {
    /**
     * POST /api/v1/requests/:id/hotel-search
     *
     * Triggers the full hotel search orchestration for a booking request.
     * Steps 1-6 from the SETT Phase 1 guide.
     */
    search(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * POST /api/v1/requests/:id/hotel-search/option-details
     *
     * Fetches and caches OptionDetailsV2 for selected TIDs.
     * Step 6 from the SETT Phase 1 guide (exact per-night pricing + cancellation policy).
     */
    optionDetails(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * GET /api/v1/requests/:id/hotel-search/events
     *
     * SSE stream — emits hotelProbeProgress and hotelProbeCompleted events
     * as each HotelProbeJob finishes processing in the worker.
     */
    events(req: Request, res: Response): Promise<void>;
    /**
     * GET /api/v1/requests/:id/hotel-search/status
     *
     * Polling endpoint — returns current state of all HotelProbeJobs for
     * this search request (for clients that cannot use SSE).
     */
    probeStatus(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * POST /api/v1/requests/:id/hotel-search/calculate-price
     *
     * Calculates the recommended customer sell price for a given buying price + markup.
     * Step 7 from the SETT Phase 1 guide.
     */
    calculatePrice(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
}
declare const _default: HotelSearchController;
export default _default;

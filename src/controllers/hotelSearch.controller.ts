import { Request, Response, NextFunction } from 'express';
import hotelSearchService from '../services/hotelSearch.service';
import hotelProbeJobRepository from '../repositories/hotelProbeJob.repository';
import hotelSearchRepository from '../repositories/hotelSearch.repository';
import requestRepository from '../repositories/request.repository';
import { subscribe } from '../services/sseManager';
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
                facilityIds: body.facilityIds,
                lang: body.lang,
            });

            return sendResponse(res, 200, result, 'Hotel search completed');
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/v1/requests/:id/hotel-search/alternatives
     *
     * User-triggered relaxed-criteria search ("Show alternatives" button).
     * Returns hotels matching widened criteria, excluding hotelCodes already
     * shown by the main search. The body may carry the relaxation level used
     * by the main search so we know where to start on the ladder.
     */
    async searchAlternatives(req: Request, res: Response, next: NextFunction) {
        try {
            const requestId = req.params['id'] as string;
            const body = (req as any).validated?.body ?? req.body ?? {};

            const result = await hotelSearchService.searchAlternativesForRequest(
                requestId,
                {
                    mealType: body.mealType,
                    waitSeconds: body.waitSeconds,
                    currencyCode: body.currencyCode,
                    nationalityCode: body.nationalityCode,
                    facilityIds: body.facilityIds,
                    lang: body.lang,
                },
                body.appliedLevel,
            );

            return sendResponse(res, 200, result, 'Alternative hotel search triggered');
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
     * GET /api/v1/requests/:id/hotel-search/events
     *
     * SSE stream — emits hotelProbeProgress and hotelProbeCompleted events
     * as each HotelProbeJob finishes processing in the worker.
     */
    async events(req: Request, res: Response) {
        const requestId = req.params['id'] as string;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
        res.flushHeaders();

        // Register this response for broadcasts from the worker
        subscribe(requestId, res);

        // Send an initial heartbeat so the client knows the stream is open
        res.write(`event: connected\ndata: ${JSON.stringify({ requestId, message: 'Subscribed to hotel probe events' })}\n\n`);

        // Keep-alive ping every 20 s
        const pingInterval = setInterval(() => {
            res.write(': ping\n\n');
        }, 20_000);

        req.on('close', () => clearInterval(pingInterval));
    }

    /**
     * GET /api/v1/requests/:id/hotel-search/status
     *
     * Polling endpoint — returns current state of all HotelProbeJobs for
     * this search request (for clients that cannot use SSE).
     */
    async probeStatus(req: Request, res: Response, next: NextFunction) {
        try {
            const requestId = req.params['id'] as string;
            const [jobs, storedPhase] = await Promise.all([
                hotelProbeJobRepository.findBySearchRequest(requestId),
                requestRepository.getSearchPhase(requestId),
            ]);

            type JobRow = { status: string };
            // Terminal-detection signal for the polling FE. The watcher writes
            // 'in_progress' at search start and flips to 'settled' / 'exhausted'
            // before broadcasting the corresponding SSE event. NULL means no
            // search has been started yet — FE treats null as 'in_progress'
            // for safety. Don't infer from queued/running counts alone: with
            // pagination they can transiently be 0 between batches.
            const phase: 'in_progress' | 'settled' | 'exhausted' = storedPhase ?? 'in_progress';

            const summary = {
                total:     jobs.length,
                queued:    jobs.filter((j: JobRow) => j.status === 'QUEUED').length,
                running:   jobs.filter((j: JobRow) => j.status === 'RUNNING' || j.status === 'PROBING').length,
                completed: jobs.filter((j: JobRow) => j.status === 'COMPLETED').length,
                skipped:   jobs.filter((j: JobRow) => j.status === 'SKIPPED_INSUFFICIENT').length,
                failed:    jobs.filter((j: JobRow) => j.status === 'FAILED').length,
                phase,
            };

            // Retroactive multi-lang description merge — re-resolve EN/DE
            // descriptions from GIATA at response time so jobs persisted
            // before the multi-lang deploy (which only have the legacy
            // `description` field) still drive a working EN↔DE toggle on the
            // FE. Cost is one batched hotel lookup per status poll; trivial
            // compared to the per-hotel probe roundtrips already in flight.
            const completedJobs = jobs.filter(
                (j: any) => j.status === 'COMPLETED' && j.resultJson?.hotelCode,
            );
            const hotelCodes = [
                ...new Set(completedJobs.map((j: any) => j.resultJson.hotelCode as string)),
            ];
            const hotelMap = await hotelSearchRepository.getHotelsByCode(hotelCodes);
            const enrichedJobs = jobs.map((j: any) => {
                const code = j.resultJson?.hotelCode;
                if (!code) return j;
                const row = hotelMap.get(code);
                if (!row?.descriptions) return j;
                return {
                    ...j,
                    resultJson: { ...j.resultJson, descriptions: row.descriptions },
                };
            });

            return sendResponse(res, 200, { requestId, summary, jobs: enrichedJobs }, 'Probe status');
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

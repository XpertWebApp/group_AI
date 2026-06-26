import { Router, Request, Response, NextFunction } from 'express';
import nationalityRepository from '../repositories/nationality.repository';
import staticDataService from '../services/staticData.service';
import { sendResponse } from '../utils/response';
import logger from '../utils/logger';

const router = Router();

/**
 * GET /api/v1/nationalities
 *
 * Returns every nationality from the `master.nationalities` table, ordered
 * alphabetically by name. Used by the Create Request form's nationality
 * dropdown.
 *
 * Auth: none. The list is non-sensitive reference data (same posture as
 * destinations search).
 *
 * Cache-warm behaviour: if the table is empty (e.g. fresh deployment that
 * hasn't run the weekly static-data sync yet), we trigger one synchronous
 * sync inline before responding so the FE form is never blocked by an
 * empty list. Subsequent requests hit the cached rows directly.
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        let rows = await nationalityRepository.findAll();

        if (rows.length === 0) {
            logger.warn('Nationality table is empty — triggering inline sync to warm the cache');
            try {
                await staticDataService.syncNationalities();
                rows = await nationalityRepository.findAll();
            } catch (err: any) {
                logger.error({ msg: 'Inline nationality sync failed', error: err?.message });
                // Fall through with the empty list — better than a 500.
            }
        }

        return sendResponse(res, 200, rows, 'Nationalities retrieved');
    } catch (err) {
        next(err);
    }
});

export default router;

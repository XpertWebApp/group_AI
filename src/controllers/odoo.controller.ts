import { Request, Response, NextFunction } from 'express';
import { odooClient, OdooApiError, OdooUnavailableError } from '../services/odoo.client.service';
import { sendResponse } from '../utils/response';

export class OdooController {
    /**
     * GET /api/v1/odoo/customers/search?q=…&limit=…
     *
     * Returns up to `limit` Odoo companies whose name contains `q` (case-
     * insensitive). Powers the live autocomplete on the Group Tool's
     * Company field.
     *
     * Error policy:
     *   - Odoo unreachable / 5xx → 503 with code ODOO_UNAVAILABLE so the FE
     *     can surface "Odoo is temporarily unreachable" and keep Send Offer
     *     blocked.
     *   - Odoo returns a logical error (bad domain, etc.) → 422.
     */
    async searchCustomers(req: Request, res: Response, next: NextFunction) {
        try {
            const q = (req as any).validated?.query?.q ?? req.query['q'];
            const limit = (req as any).validated?.query?.limit ?? 20;
            const rows = await odooClient.searchCompanies(String(q), Number(limit));
            return sendResponse(res, 200, rows, 'Odoo customers retrieved');
        } catch (err) {
            if (err instanceof OdooUnavailableError) {
                return sendResponse(res, 503, null, 'Odoo is temporarily unreachable. Please try again.', 'ODOO_UNAVAILABLE');
            }
            if (err instanceof OdooApiError) {
                return sendResponse(res, 422, null, err.message, err.code ?? 'ODOO_API_ERROR');
            }
            return next(err);
        }
    }
}

export default new OdooController();

import { Request, Response, NextFunction } from 'express';
import settingsService from '../services/settings.service';
import { logAuditEvent } from '../utils/audit';
import { sendResponse } from '../utils/response';

export class SettingsController {
    /**
     * GET /api/v1/settings
     * Returns the settings overview (5 cards with last-updated timestamps).
     */
    async overview(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await settingsService.getOverview();
            return sendResponse(res, 200, result, 'Settings overview retrieved');
        } catch (error) {
            next(error);
        }
    }

    // ── General Configuration ────────────────────────────────────────────────

    /**
     * GET /api/v1/settings/general
     */
    async getGeneralConfig(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await settingsService.getGeneralConfig();
            return sendResponse(res, 200, result, 'General configuration retrieved');
        } catch (error) {
            next(error);
        }
    }

    /**
     * PUT /api/v1/settings/general
     */
    async updateGeneralConfig(req: Request, res: Response, next: NextFunction) {
        try {
            const data = (req as any).validated.body;
            const result = await settingsService.updateGeneralConfig(data);
            return sendResponse(res, 200, result, 'General configuration updated');
        } catch (error) {
            next(error);
        }
    }

    // ── Email Configuration (Brevo SMTP) ─────────────────────────────────────

    /**
     * GET /api/v1/settings/email
     * Returns the three-block payload: senderIdentity, connection, intercept.
     * See `email-config-settings-handover.md` §4.1.
     */
    async getEmailConfig(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await settingsService.getEmailConfig();
            return sendResponse(res, 200, result, 'Email configuration retrieved');
        } catch (error) {
            next(error);
        }
    }

    /**
     * PUT /api/v1/settings/email
     * Partial update of senderIdentity fields. Returns the full email-config
     * payload (same shape as GET) so the FE can re-render off the response.
     */
    async updateEmailConfig(req: Request, res: Response, next: NextFunction) {
        try {
            const data = (req as any).validated.body;
            const result = await settingsService.updateEmailConfig(data);
            await logAuditEvent({
                userId: (req as any).user?.id,
                action: 'settings.email.update',
                entity: 'settings',
                entityId: 'email',
                details: { keys: Object.keys(data) },
            });
            return sendResponse(res, 200, result, 'Email configuration updated');
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/v1/settings/email/test-status
     * Forces a fresh transporter.verify() call against Brevo and returns
     * the connection state. Bypasses the 60s cache used by GET /settings/email.
     * Always returns 200 — the connection state is data, not an error.
     */
    async getEmailTestStatus(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await settingsService.refreshEmailTestStatus();
            return sendResponse(res, 200, result, 'Email test status refreshed');
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/v1/settings/email/test-send
     * Sends a small "configuration test" email via the live Brevo transport.
     * Rate-limited by middleware (1/min per IP).
     */
    async sendEmailTest(req: Request, res: Response, next: NextFunction) {
        try {
            const { to } = (req as any).validated.body as { to: string };
            const result = await settingsService.sendTestEmail(to);
            await logAuditEvent({
                userId: (req as any).user?.id,
                action: 'settings.email.test_send',
                entity: 'settings',
                entityId: 'email',
                details: { to },
            });
            return sendResponse(res, 200, result, 'Test email sent');
        } catch (error) {
            next(error);
        }
    }

    // ── Company Details ──────────────────────────────────────────────────────

    /**
     * GET /api/v1/settings/company
     */
    async getCompanyDetails(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await settingsService.getCompanyDetails();
            return sendResponse(res, 200, result, 'Company details retrieved');
        } catch (error) {
            next(error);
        }
    }

    /**
     * PUT /api/v1/settings/company
     */
    async updateCompanyDetails(req: Request, res: Response, next: NextFunction) {
        try {
            const data = (req as any).validated.body;
            const result = await settingsService.updateCompanyDetails(data);
            return sendResponse(res, 200, result, 'Company details updated');
        } catch (error) {
            next(error);
        }
    }

    // ── Policies ─────────────────────────────────────────────────────────────

    /**
     * GET /api/v1/settings/policies
     */
    async getPolicies(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await settingsService.getPolicies();
            return sendResponse(res, 200, result, 'Policies retrieved');
        } catch (error) {
            next(error);
        }
    }

    /**
     * PUT /api/v1/settings/policies
     */
    async updatePolicies(req: Request, res: Response, next: NextFunction) {
        try {
            const data = (req as any).validated.body;
            const result = await settingsService.updatePolicies(data);
            return sendResponse(res, 200, result, 'Policies updated');
        } catch (error) {
            next(error);
        }
    }

    // ── Supplier Limits ──────────────────────────────────────────────────────

    /**
     * GET /api/v1/settings/supplier-limits
     */
    async getSupplierLimits(req: Request, res: Response, next: NextFunction) {
        try {
            const query = (req as any).validated?.query ?? req.query;
            const result = await settingsService.getSupplierLimits({
                search: query.search,
                page: query.page,
                limit: query.limit,
            });
            return sendResponse(res, 200, result, 'Supplier limits retrieved');
        } catch (error) {
            next(error);
        }
    }

    /**
     * PATCH /api/v1/settings/supplier-limits/:supplierCode
     */
    async updateSupplierLimit(req: Request, res: Response, next: NextFunction) {
        try {
            const { supplierCode } = req.params;
            const data = (req as any).validated.body;
            const result = await settingsService.updateSupplierLimit(supplierCode as string, data);
            return sendResponse(res, 200, result, 'Supplier limit updated');
        } catch (error) {
            next(error);
        }
    }
}

export default new SettingsController();

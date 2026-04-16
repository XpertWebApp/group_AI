import { Request, Response, NextFunction } from 'express';
export declare class SettingsController {
    /**
     * GET /api/v1/settings
     * Returns the settings overview (5 cards with last-updated timestamps).
     */
    overview(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * GET /api/v1/settings/general
     */
    getGeneralConfig(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * PUT /api/v1/settings/general
     */
    updateGeneralConfig(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * GET /api/v1/settings/email
     */
    getEmailConfig(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * PUT /api/v1/settings/email
     */
    updateEmailConfig(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * GET /api/v1/settings/company
     */
    getCompanyDetails(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * PUT /api/v1/settings/company
     */
    updateCompanyDetails(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * GET /api/v1/settings/policies
     */
    getPolicies(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * PUT /api/v1/settings/policies
     */
    updatePolicies(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * GET /api/v1/settings/supplier-limits
     */
    getSupplierLimits(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /**
     * PATCH /api/v1/settings/supplier-limits/:supplierCode
     */
    updateSupplierLimit(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
}
declare const _default: SettingsController;
export default _default;

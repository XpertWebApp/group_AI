import { Request, Response, NextFunction } from 'express';
export declare class StaffController {
    /** GET /api/v1/settings/staff */
    list(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /** POST /api/v1/settings/staff */
    add(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /** PATCH /api/v1/settings/staff/:id/status */
    toggleStatus(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /** POST /api/v1/settings/staff/:id/reset-password */
    resetPassword(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /** DELETE /api/v1/settings/staff/:id */
    delete(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
}
declare const _default: StaffController;
export default _default;

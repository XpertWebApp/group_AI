import { Request, Response, NextFunction } from 'express';
export declare class GiataSyncController {
    /** POST /api/v1/settings/giata/sync — trigger full GIATA sync */
    triggerFullSync(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /** POST /api/v1/settings/giata/sync/incremental — trigger incremental sync */
    triggerIncrementalSync(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /** POST /api/v1/settings/giata/sync/:hotelCode — sync a single hotel */
    syncSingleHotel(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /** GET /api/v1/settings/giata/status — sync status overview */
    getStatus(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /** GET /api/v1/settings/giata/missing — hotels without GIATA data */
    getMissingHotels(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /** POST /api/v1/settings/giata/resolve — resolve missing GIATA codes via Multicodes */
    resolveGiataCodes(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
}
declare const _default: GiataSyncController;
export default _default;

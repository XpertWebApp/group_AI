import { Request, Response, NextFunction } from 'express';
export declare class HotelController {
    search(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    getDetails(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
}
declare const _default: HotelController;
export default _default;

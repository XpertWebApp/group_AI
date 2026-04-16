import { Request, Response, NextFunction } from 'express';
export declare class ProposalsController {
    list(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    get(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    create(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    updateMetadata(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    addHotel(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    removeHotel(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    listHotels(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    adjustHotelPricing(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    toggleHotelIncluded(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    addService(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    updateService(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    removeService(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    lock(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    unlock(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    saveDraft(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    send(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    previewPdf(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /** GET /:id/offers — list offer history for a proposal */
    listOffers(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    /** GET /:id/offers/:offerId/pdf — download the PDF for a specific offer */
    downloadOfferPdf(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    approve(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
    decline(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
}
declare const _default: ProposalsController;
export default _default;

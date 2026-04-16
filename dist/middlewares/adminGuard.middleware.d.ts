import { Request, Response, NextFunction } from 'express';
export declare const adminGuard: (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;

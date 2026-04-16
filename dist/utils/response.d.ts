import { Response } from 'express';
export declare const sendResponse: (res: Response, statusCode: number, data?: any, message?: string, error?: string | null) => Response<any, Record<string, any>>;

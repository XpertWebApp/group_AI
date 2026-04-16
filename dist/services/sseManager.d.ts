import { Response } from 'express';
export declare function subscribe(searchRequestId: string, res: Response): void;
export declare function broadcast(searchRequestId: string, event: string, data: unknown): void;
export declare function subscriberCount(searchRequestId: string): number;

import { Response } from 'express';

interface ApiResponse {
    success: boolean;
    data: any;
    message: string;
    error?: string | null;
}

export const sendResponse = (
    res: Response,
    statusCode: number,
    data: any = null,
    message: string = 'Success',
    error: string | null = null,
) => {
    const response: ApiResponse = {
        success: statusCode >= 200 && statusCode < 300,
        data,
        message,
    };

    if (error) {
        response.error = error;
    }

    return res.status(statusCode).json(response);
};

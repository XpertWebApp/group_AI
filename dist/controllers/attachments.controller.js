"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AttachmentsController = exports.upload = void 0;
const multer_1 = __importDefault(require("multer"));
const storage_service_1 = __importDefault(require("../services/storage.service"));
const config_1 = __importDefault(require("../config"));
const logger_1 = __importDefault(require("../utils/logger"));
const client_1 = require("@prisma/client");
const response_1 = require("../utils/response");
const prisma = new client_1.PrismaClient();
const ALLOWED_MIME_TYPES = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/plain',
    'image/jpeg',
    'image/png',
    'image/webp',
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 5;
exports.upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
            cb(null, true);
        }
        else {
            cb(new Error(`File type ${file.mimetype} is not allowed. Accepted: PDF, DOC, DOCX, XLS, XLSX, CSV, TXT, JPEG, PNG, WEBP`));
        }
    },
});
class AttachmentsController {
    async upload(req, res, next) {
        try {
            const requestId = req.params['id'];
            // Verify the booking request exists
            const bookingRequest = await prisma.bookingRequest.findUnique({ where: { id: requestId } });
            if (!bookingRequest) {
                return (0, response_1.sendResponse)(res, 404, null, 'Booking request not found');
            }
            const files = req.files;
            if (!files || files.length === 0) {
                return (0, response_1.sendResponse)(res, 400, null, 'No files provided');
            }
            const attachments = [];
            for (const file of files) {
                const timestamp = Date.now();
                const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
                const key = `requests/${requestId}/attachments/${timestamp}-${safeName}`;
                const fileUrl = await storage_service_1.default.uploadFile(key, file.buffer, file.mimetype);
                const attachment = await prisma.bookingRequestAttachment.create({
                    data: {
                        bookingRequestId: requestId,
                        fileKey: key,
                        originalName: file.originalname,
                        mimeType: file.mimetype,
                        size: file.size,
                    },
                });
                attachments.push({
                    id: attachment.id,
                    fileKey: attachment.fileKey,
                    originalName: attachment.originalName,
                    mimeType: attachment.mimeType,
                    size: attachment.size,
                    url: fileUrl,
                    createdAt: attachment.createdAt,
                });
            }
            // Update guestListFileKey on the booking request with the first attachment's key
            // (maintains backward compatibility with the existing field)
            if (attachments.length > 0) {
                await prisma.bookingRequest.update({
                    where: { id: requestId },
                    data: { guestListFileKey: attachments[0].fileKey },
                });
            }
            logger_1.default.info({ requestId, count: attachments.length }, 'Attachments uploaded');
            return (0, response_1.sendResponse)(res, 201, attachments, `${attachments.length} file(s) uploaded`);
        }
        catch (error) {
            next(error);
        }
    }
    async list(req, res, next) {
        try {
            const requestId = req.params['id'];
            const attachments = await prisma.bookingRequestAttachment.findMany({
                where: { bookingRequestId: requestId },
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true,
                    fileKey: true,
                    originalName: true,
                    mimeType: true,
                    size: true,
                    createdAt: true,
                },
            });
            const result = attachments.map((a) => ({
                ...a,
                url: `${config_1.default.s3.endpoint}/${config_1.default.s3.bucket}/${a.fileKey}`,
            }));
            return (0, response_1.sendResponse)(res, 200, result, 'Attachments retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    async delete(req, res, next) {
        try {
            const requestId = req.params['id'];
            const attachmentId = req.params['attachmentId'];
            const attachment = await prisma.bookingRequestAttachment.findFirst({
                where: { id: attachmentId, bookingRequestId: requestId },
            });
            if (!attachment) {
                return (0, response_1.sendResponse)(res, 404, null, 'Attachment not found');
            }
            // Delete from S3
            await storage_service_1.default.deleteFile(attachment.fileKey);
            // Delete from DB
            await prisma.bookingRequestAttachment.delete({ where: { id: attachmentId } });
            // If this was the guestListFileKey, clear it
            const bookingRequest = await prisma.bookingRequest.findUnique({ where: { id: requestId } });
            if (bookingRequest?.guestListFileKey === attachment.fileKey) {
                // Set to the next attachment's key, or null if none left
                const remaining = await prisma.bookingRequestAttachment.findFirst({
                    where: { bookingRequestId: requestId },
                    orderBy: { createdAt: 'asc' },
                });
                await prisma.bookingRequest.update({
                    where: { id: requestId },
                    data: { guestListFileKey: remaining?.fileKey ?? null },
                });
            }
            logger_1.default.info({ requestId, attachmentId, fileKey: attachment.fileKey }, 'Attachment deleted');
            return (0, response_1.sendResponse)(res, 200, null, 'Attachment deleted');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.AttachmentsController = AttachmentsController;
exports.default = new AttachmentsController();

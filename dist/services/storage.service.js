"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_s3_1 = require("@aws-sdk/client-s3");
const config_1 = __importDefault(require("../config"));
const logger_1 = __importDefault(require("../utils/logger"));
class StorageService {
    constructor() {
        this.client = null;
    }
    getClient() {
        if (!this.client) {
            if (!config_1.default.s3.endpoint || !config_1.default.s3.accessKeyId) {
                throw new Error('S3 storage is not configured. Set S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY in .env');
            }
            this.client = new client_s3_1.S3Client({
                endpoint: config_1.default.s3.endpoint,
                region: config_1.default.s3.region,
                credentials: {
                    accessKeyId: config_1.default.s3.accessKeyId,
                    secretAccessKey: config_1.default.s3.secretAccessKey,
                },
                forcePathStyle: true,
            });
        }
        return this.client;
    }
    async uploadFile(key, buffer, contentType) {
        const client = this.getClient();
        await client.send(new client_s3_1.PutObjectCommand({
            Bucket: config_1.default.s3.bucket,
            Key: key,
            Body: buffer,
            ContentType: contentType,
            ACL: 'public-read',
        }));
        const url = `${config_1.default.s3.endpoint}/${config_1.default.s3.bucket}/${key}`;
        logger_1.default.info({ key, size: buffer.length, contentType }, 'File uploaded to S3');
        return url;
    }
    async deleteFile(key) {
        try {
            const client = this.getClient();
            await client.send(new client_s3_1.DeleteObjectCommand({
                Bucket: config_1.default.s3.bucket,
                Key: key,
            }));
            logger_1.default.info({ key }, 'File deleted from S3');
        }
        catch (err) {
            logger_1.default.error({ err, key }, 'Failed to delete file from S3');
        }
    }
    async uploadPdf(proposalId, filename, pdfBuffer) {
        const key = `proposals/${proposalId}/${filename}.pdf`;
        const client = this.getClient();
        await client.send(new client_s3_1.PutObjectCommand({
            Bucket: config_1.default.s3.bucket,
            Key: key,
            Body: pdfBuffer,
            ContentType: 'application/pdf',
            ACL: 'public-read',
        }));
        const url = `${config_1.default.s3.endpoint}/${config_1.default.s3.bucket}/${key}`;
        logger_1.default.info({ proposalId, key, size: pdfBuffer.length }, 'PDF uploaded to S3');
        return url;
    }
    async downloadPdf(key) {
        const client = this.getClient();
        const response = await client.send(new client_s3_1.GetObjectCommand({
            Bucket: config_1.default.s3.bucket,
            Key: key,
        }));
        const chunks = [];
        for await (const chunk of response.Body) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }
    async deletePdf(key) {
        try {
            const client = this.getClient();
            await client.send(new client_s3_1.DeleteObjectCommand({
                Bucket: config_1.default.s3.bucket,
                Key: key,
            }));
            logger_1.default.info({ key }, 'PDF deleted from S3');
        }
        catch (err) {
            logger_1.default.error({ err, key }, 'Failed to delete PDF from S3');
        }
    }
}
exports.default = new StorageService();

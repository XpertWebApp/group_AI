import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import config from '../config';
import logger from '../utils/logger';

class StorageService {
    private client: S3Client | null = null;

    private getClient(): S3Client {
        if (!this.client) {
            if (!config.s3.endpoint || !config.s3.accessKeyId) {
                throw new Error('S3 storage is not configured. Set S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY in .env');
            }
            this.client = new S3Client({
                endpoint: config.s3.endpoint,
                region: config.s3.region,
                credentials: {
                    accessKeyId: config.s3.accessKeyId,
                    secretAccessKey: config.s3.secretAccessKey,
                },
                forcePathStyle: true,
            });
        }
        return this.client;
    }

    async uploadFile(key: string, buffer: Buffer, contentType: string): Promise<string> {
        const client = this.getClient();

        await client.send(new PutObjectCommand({
            Bucket: config.s3.bucket,
            Key: key,
            Body: buffer,
            ContentType: contentType,
            ACL: 'public-read',
        }));

        const url = `${config.s3.endpoint}/${config.s3.bucket}/${key}`;
        logger.info({ key, size: buffer.length, contentType }, 'File uploaded to S3');
        return url;
    }

    async deleteFile(key: string): Promise<void> {
        try {
            const client = this.getClient();
            await client.send(new DeleteObjectCommand({
                Bucket: config.s3.bucket,
                Key: key,
            }));
            logger.info({ key }, 'File deleted from S3');
        } catch (err) {
            logger.error({ err, key }, 'Failed to delete file from S3');
        }
    }

    async uploadPdf(proposalId: string, filename: string, pdfBuffer: Buffer): Promise<string> {
        const key = `proposals/${proposalId}/${filename}.pdf`;
        const client = this.getClient();

        await client.send(new PutObjectCommand({
            Bucket: config.s3.bucket,
            Key: key,
            Body: pdfBuffer,
            ContentType: 'application/pdf',
            ACL: 'public-read',
        }));

        const url = `${config.s3.endpoint}/${config.s3.bucket}/${key}`;
        logger.info({ proposalId, key, size: pdfBuffer.length }, 'PDF uploaded to S3');
        return url;
    }

    async downloadPdf(key: string): Promise<Buffer> {
        const client = this.getClient();
        const response = await client.send(new GetObjectCommand({
            Bucket: config.s3.bucket,
            Key: key,
        }));
        const chunks: Uint8Array[] = [];
        for await (const chunk of response.Body as any) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }

    async deletePdf(key: string): Promise<void> {
        try {
            const client = this.getClient();
            await client.send(new DeleteObjectCommand({
                Bucket: config.s3.bucket,
                Key: key,
            }));
            logger.info({ key }, 'PDF deleted from S3');
        } catch (err) {
            logger.error({ err, key }, 'Failed to delete PDF from S3');
        }
    }
}

export default new StorageService();

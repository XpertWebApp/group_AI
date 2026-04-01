import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from '../config';
import logger from '../utils/logger';

class StorageService {
    private client: S3Client;
    private bucket: string;

    constructor() {
        this.bucket = config.s3.bucket;
        this.client = new S3Client({
            endpoint: config.s3.endpoint || undefined,
            region: config.s3.region || 'eu-central-1',
            credentials: {
                accessKeyId: config.s3.accessKeyId,
                secretAccessKey: config.s3.secretAccessKey,
            },
            forcePathStyle: true, // Required for Hetzner / S3-compatible endpoints
        });
    }

    /** Check if S3 is configured (credentials provided). */
    isConfigured(): boolean {
        return !!(this.bucket && config.s3.accessKeyId && config.s3.secretAccessKey);
    }

    /** Upload a buffer to S3. Returns the object key. */
    async upload(key: string, buffer: Buffer, contentType = 'application/pdf'): Promise<string> {
        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: buffer,
            ContentType: contentType,
        }));
        logger.info({ key, bucket: this.bucket, size: buffer.length }, 'S3: uploaded object');
        return key;
    }

    /** Download an object from S3. Returns the body as a Buffer. */
    async download(key: string): Promise<Buffer> {
        const response = await this.client.send(new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
        }));
        const stream = response.Body as NodeJS.ReadableStream;
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }

    /** Generate a presigned URL for direct download. */
    async getPresignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
        });
        return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
    }

    /** Delete an object from S3. */
    async delete(key: string): Promise<void> {
        await this.client.send(new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: key,
        }));
        logger.info({ key, bucket: this.bucket }, 'S3: deleted object');
    }

    /** Build a standard S3 key for proposal PDFs. */
    buildProposalPdfKey(proposalId: string): string {
        return `proposals/${proposalId}/offer-${Date.now()}.pdf`;
    }
}

export default new StorageService();

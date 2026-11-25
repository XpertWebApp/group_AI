import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from '../config';
import logger from '../utils/logger';

/**
 * S3-compatible object storage (Hetzner Object Storage in production).
 *
 * Exposes two complementary APIs that grew up in parallel branches:
 *   - Generic key-returning methods (`upload`, `download`, `getPresignedUrl`,
 *     `delete`, `buildProposalPdfKey`, `isConfigured`) — used by the
 *     PDF / proposal flow that builds its own keys and stores keys only.
 *   - Higher-level URL-returning helpers (`uploadFile`, `deleteFile`,
 *     `uploadPdf`, `downloadPdf`, `deletePdf`) — used by attachments and
 *     legacy proposal-PDF call sites that store the full public URL.
 *
 * The client is constructed lazily on first use so the server still
 * starts in environments where S3 credentials are intentionally absent
 * (CI, local dev). `isConfigured()` reports whether S3 calls will work
 * without throwing.
 */
class StorageService {
    private client: S3Client | null = null;

    /** True when the S3 client can be safely constructed and used. */
    isConfigured(): boolean {
        return !!(config.s3.bucket && config.s3.accessKeyId && config.s3.secretAccessKey);
    }

    private getClient(): S3Client {
        if (!this.client) {
            if (!config.s3.endpoint || !config.s3.accessKeyId) {
                throw new Error('S3 storage is not configured. Set S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY in .env');
            }
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
        return this.client;
    }

    // ─── Low-level (key-returning) API ──────────────────────────────────

    /** Upload a buffer to S3. Returns the object key. */
    async upload(key: string, buffer: Buffer, contentType = 'application/pdf'): Promise<string> {
        const client = this.getClient();
        await client.send(new PutObjectCommand({
            Bucket: config.s3.bucket,
            Key: key,
            Body: buffer,
            ContentType: contentType,
        }));
        logger.info({ key, bucket: config.s3.bucket, size: buffer.length }, 'S3: uploaded object');
        return key;
    }

    /** Download an object from S3. Returns the body as a Buffer. */
    async download(key: string): Promise<Buffer> {
        const client = this.getClient();
        const response = await client.send(new GetObjectCommand({
            Bucket: config.s3.bucket,
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
            Bucket: config.s3.bucket,
            Key: key,
        });
        return getSignedUrl(this.getClient(), command, { expiresIn: expiresInSeconds });
    }

    /** Delete an object from S3. */
    async delete(key: string): Promise<void> {
        const client = this.getClient();
        await client.send(new DeleteObjectCommand({
            Bucket: config.s3.bucket,
            Key: key,
        }));
        logger.info({ key, bucket: config.s3.bucket }, 'S3: deleted object');
    }

    /** Build a standard S3 key for proposal PDFs. */
    buildProposalPdfKey(proposalId: string): string {
        return `proposals/${proposalId}/offer-${Date.now()}.pdf`;
    }

    // ─── High-level (URL-returning) API ─────────────────────────────────

    /**
     * Upload a generic file at the given key with public-read ACL. Returns
     * a directly-addressable URL composed from endpoint + bucket + key.
     * Used by attachment uploads that store the full URL on the row.
     */
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

    /** Best-effort delete; swallows + logs failures. */
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

    /** Upload a proposal PDF under the conventional `proposals/<id>/<filename>.pdf` key. */
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

    /** Alias of `download` preserved for legacy callers. */
    async downloadPdf(key: string): Promise<Buffer> {
        return this.download(key);
    }

    /** Best-effort delete; swallows + logs failures. */
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

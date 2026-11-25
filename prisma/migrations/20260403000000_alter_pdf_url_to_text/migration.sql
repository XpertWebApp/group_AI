-- AlterTable: change pdf_url from VARCHAR(1000) to TEXT to support base64-encoded PDF storage
ALTER TABLE "app"."proposals" ALTER COLUMN "pdf_url" TYPE TEXT;

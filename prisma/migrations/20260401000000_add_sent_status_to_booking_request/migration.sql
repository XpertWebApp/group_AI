-- Add 'sent' to BookingRequestStatus enum
ALTER TYPE "app"."BookingRequestStatus" ADD VALUE IF NOT EXISTS 'sent';

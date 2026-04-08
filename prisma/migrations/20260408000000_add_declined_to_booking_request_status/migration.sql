-- AlterEnum: add 'declined' value to BookingRequestStatus so a request can reflect
-- when its offer was declined by the client (after being sent).
ALTER TYPE "app"."BookingRequestStatus" ADD VALUE IF NOT EXISTS 'declined';

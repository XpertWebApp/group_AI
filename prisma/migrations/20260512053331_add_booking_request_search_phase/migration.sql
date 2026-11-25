-- Terminal-detection signal for the polling frontend.
-- Values: 'in_progress' | 'settled' | 'exhausted'.
-- NULL means no search has been started yet for this request (or it's a
-- historical row pre-dating this column). The frontend treats NULL as
-- 'in_progress' for safety. No backfill needed — historical rows are
-- complete and won't be re-checked.
-- AlterTable
ALTER TABLE "app"."booking_requests" ADD COLUMN     "search_phase" VARCHAR(20);

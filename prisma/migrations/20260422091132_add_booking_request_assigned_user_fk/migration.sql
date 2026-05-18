-- DropIndex
DROP INDEX "master"."hotels_total_rooms_idx";

-- AlterTable
ALTER TABLE "app"."proposal_offers" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "sent_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "sent_to_emails" DROP DEFAULT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "app"."proposals" ALTER COLUMN "approved_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "rejected_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "auth"."users" ALTER COLUMN "google_token_expiry" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "master"."hotel_giata_facts" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "synced_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "master"."hotel_giata_images" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "last_update" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "synced_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "master"."hotel_giata_mappings" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "synced_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "master"."hotel_giata_texts" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "last_update" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "synced_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "master"."hotels" ALTER COLUMN "giata_synced_at" SET DATA TYPE TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "app"."booking_requests" ADD CONSTRAINT "booking_requests_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

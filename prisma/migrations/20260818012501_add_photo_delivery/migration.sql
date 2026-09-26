-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "cover_photo" VARCHAR(500),
ADD COLUMN     "delivery_fee" INTEGER,
ADD COLUMN     "delivery_time" VARCHAR(60),
ADD COLUMN     "has_delivery" BOOLEAN NOT NULL DEFAULT false;

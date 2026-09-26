-- AlterTable
ALTER TABLE "reviews" ADD COLUMN     "photos" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "district_id" INTEGER;

-- CreateIndex
CREATE INDEX "users_district_id_idx" ON "users"("district_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_district_id_fkey" FOREIGN KEY ("district_id") REFERENCES "districts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

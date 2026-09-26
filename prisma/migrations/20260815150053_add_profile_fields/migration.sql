-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "age" INTEGER,
ADD COLUMN     "avatar_id" VARCHAR(40),
ADD COLUMN     "gender" "Gender";

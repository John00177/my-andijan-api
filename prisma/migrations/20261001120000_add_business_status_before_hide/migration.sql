-- Phase 14 (D-73): durable record of the status a business had when it was
-- hidden, so unhide can restore it exactly. Additive and nullable — existing
-- rows get NULL (unhide then restores to PENDING), no data is rewritten.
-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "status_before_hide" "BusinessStatus";

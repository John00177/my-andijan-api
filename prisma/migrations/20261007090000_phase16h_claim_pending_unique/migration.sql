-- ============================================================================
-- Phase 16H: at most ONE pending claim per (business, claimant).
--
-- createClaim checked "no pending claim yet" and then inserted, with nothing in
-- the database behind the check — two concurrent submissions (a double-tapped
-- button, a retried request) could both pass it and file two PENDING claims.
-- A partial unique index makes the database the guarantee; the service maps
-- the violation to the same 409 the friendly pre-check returns.
--
-- Scope is deliberately (business, claimant), NOT (business): competing claims
-- from DIFFERENT people on one listing are legitimate and stay allowed — staff
-- see them flagged as competing, and approving one rejects the rest
-- (AdminService.approveClaim). REJECTED/APPROVED history is unconstrained, so a
-- rejected claimant can file again.
--
-- Not modelled in schema.prisma: Prisma cannot express a partial index, and
-- its drift detection does not report one (test/db/claims-concurrency.db-spec.ts
-- asserts the migrated database still matches the schema).
-- ============================================================================

-- No claim may be written between the clean-up and the index build below
-- (a duplicate committed in between would make CREATE UNIQUE INDEX fail).
-- Reads continue; the table is tiny, so writers wait milliseconds.
LOCK TABLE "business_claims" IN SHARE ROW EXCLUSIVE MODE;

-- Duplicates the old race may already have produced: keep each pair's
-- earliest PENDING claim (the one the claimant filed first) and close the
-- rest. Rows are kept, not deleted, and the reason says why.
UPDATE "business_claims" AS dup
SET "status" = 'REJECTED',
    "reviewed_at" = now(),
    "rejection_reason" = 'Duplicate of an earlier pending claim by the same user (closed automatically)',
    "updated_at" = now()
WHERE dup."status" = 'PENDING'
  AND EXISTS (
    SELECT 1
    FROM "business_claims" AS earlier
    WHERE earlier."business_id" = dup."business_id"
      AND earlier."claimant_id" = dup."claimant_id"
      AND earlier."status" = 'PENDING'
      AND (earlier."created_at", earlier."id") < (dup."created_at", dup."id")
  );

CREATE UNIQUE INDEX "business_claims_one_pending_per_claimant"
  ON "business_claims" ("business_id", "claimant_id")
  WHERE "status" = 'PENDING';

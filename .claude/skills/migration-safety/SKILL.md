---
name: migration-safety
description: Safety checklist for My Andijan database migrations (Prisma + PostgreSQL on Railway). Use whenever you create, edit or review anything under prisma/migrations or prisma/schema.prisma in my-andijan-api, or plan a schema change.
---

# Migration safety — My Andijan API

Why this exists: Railway runs `npx prisma migrate deploy` **before** the new code starts, with no timeout, and API `main` can deploy the moment it is merged (Auto Deploy on, Wait for CI off). A careless migration can lock a live table or break the running app. Blocker B4 of the Phase 16 release came from a migration that skipped item 3 below.

Repo: `D:\My-Andijan-Work\my-andijan-api`. Background: `docs/my-andijan/DATABASE.md` (frontend repo), `db/privileges/RUNBOOK.md` §10 (API repo).

## Checklist — every item must be answered in the PR description

1. **Local only.** `npx prisma migrate dev` on a local database. Never `migrate deploy`, `db push` or `migrate reset` against anything non-local.
2. **Backward-compatible.** The old code keeps serving while the migration runs, and a Railway rollback restores old code but **not** the old schema. So: add columns as nullable or with a default; rename = add + copy + drop in a later release; drop only what the code already stopped using in a previous release.
3. **Bounded locks.** If the migration takes a lock on a live table (`LOCK TABLE`, `ALTER TABLE` that rewrites or validates, `CREATE INDEX` without `CONCURRENTLY`, constraint adds), start it with:
   ```sql
   SET LOCAL lock_timeout = '30s';
   ```
   House precedent: `20261003090000_phase15e4e1…` and `20261004090000_phase15e4e2…`. Add a check in `test/db/migration-contract.db-spec.ts`. Say in the PR which lock is taken on which table.
4. **SIG Gate 2 is paused (D-80): no `GRANT` to `runtime_app_public`** — not in a migration, a script or manual SQL. Never grant on `sig_*` objects; never `ALTER DEFAULT PRIVILEGES`. When the owner resumes Gate 2 and Phase A has run, `RUNBOOK.md` §10 grant rules apply instead.
5. **Data changes** (`UPDATE`/`DELETE`/dedupe): write the read-only query that counts affected rows, so it can be run on deploy day and compared afterwards.
6. **Never edit a migration that has been applied anywhere** (checksum). A merged-but-not-yet-applied migration may be edited only with the owner's decision.
7. **Tests.** `npm test`; `npm run build`; `npm run test:db` with `TEST_DATABASE_URL` pointing at a **disposable local** database whose name contains `test`.
8. **Do not merge.** Merging to API `main` can deploy immediately. Open the PR and stop; merging is the owner's decision and follows the `api-release` skill.

## Output

End with this table for the owner:

| Check | Result |
| --- | --- |
| Local only | ✅ / ❌ |
| Backward-compatible | ✅ / ❌ + why |
| Lock + timeout | table, lock type, `lock_timeout` yes/no |
| No GRANT while Gate 2 paused | ✅ / ❌ |
| Rows affected | query + local count |
| Tests | commands + pass/fail |

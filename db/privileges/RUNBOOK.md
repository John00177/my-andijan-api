# SIG Gate 2 — Database privilege boundary runbook

> **Status: reviewed procedure, not an authorization.** Merging this file does **not** authorize any production step.
> Every production step below is performed by the owner, or read-only by Claude, **only** after the owner has explicitly
> authorized that step, inside an agreed maintenance window. The gate record (evidence, decisions, session log) lives
> outside this repository, in `D:\My-Andijan\security-governance\SIG\gates\gate-02\`.
>
> **No secret ever appears here, in these SQL files, in CI, in logs, in gate files or in chat.** Role passwords are set
> by the owner only, with psql `\password`, and connection URLs are composed only inside Railway's variable editor (RB-D4).

## 1. What this does

It ends the production runtime's use of the PostgreSQL superuser. Today one superuser, `postgres`, owns every object,
and the API connects as that superuser (Gate 2 pre-check, 2026-10-05). After Gate 2:

| Role | Login | Holds |
|---|---|---|
| `migration_owner` | yes (pre-deploy migrations only) | Owns every application object: tables, sequences, the 4 search functions, the Prisma enum types, `_prisma_migrations` |
| `runtime_app_public` | yes (the API service) | `SELECT, INSERT, UPDATE, DELETE` on application tables; `USAGE, SELECT` on their sequences; `EXECUTE` on application functions. No DDL, `TRUNCATE`, `REFERENCES`, `TRIGGER`, `MAINTAIN`, ownership, `TEMP`, or access to `_prisma_migrations`. **Never anything on a `sig_*` object** |
| `runtime_app_staff`, `sig_audit_reader`, `sig_retention_job`, `sig_anchor_publisher` | **no** (no consumer yet) | nothing |
| `sig_audit_owner`, `sig_audit_writer`, `sig_context_purger`, `sig_governance_writer`, `sig_anchor_recorder` | **no** (permanent) | nothing (their objects arrive in Gate 3) |
| `postgres` | managed by Railway | Unchanged. Removed from every service configuration; owner custody; break-glass only |

All eleven Gate 2 roles are created `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`, with
no memberships. The `pg_trgm` extension and its objects stay with the superuser.

## 2. Files

| File | Kind | Purpose |
|---|---|---|
| `00_preflight_readonly.sql` | read-only | E3 pre-check (P1–P14) plus P15–P19 — state at the window start |
| `10_phase_a_boundary.sql` | **write, one transaction** | Phase A: preflight assertions (A0), roles (A1), database/schema access (A2), ownership transfer (A3), runtime grants (A4), self-check (A5) |
| `20_verify_readonly.sql` | read-only | One row per check, `PASS`/`FAIL`/`INFO` (V01–V13) — after Phase A and in Phase E |
| `30_rowcounts_readonly.sql` | read-only | Exact row count per application table — the R-E4 restore comparison |
| `90_rollback_phase_a.sql` | **write, one transaction** | Undo Phase A (only while no service uses a Gate 2 role) |

Every write file aborts on the first failed check with an exception that starts with **`G2-STOP`**, and rolls back
completely: the database is left exactly as it was.

## 3. Owner decisions applied (SIG Gate 2 report §10, 2026-10-05)

| ID | Decision | Where it is enforced |
|---|---|---|
| R-E4 | **Option 1:** before Phase A, a **fresh production dump** plus an **independently verified restore into a disposable PostgreSQL 18** environment. The existing Railway "Pre-Security-Patch Backup" is a last-resort recovery point only. **Nothing is ever restored into production** | §6 Step 2, §8 |
| RB-D1 | Explicit grants; **no default privileges** that could expose future `sig_*` objects to `runtime_app_public` | Phase A A4/A5; V09; CI |
| RB-D2 | Prisma `directUrl = env("MIGRATION_DATABASE_URL")` for migrations, after verifying the project configuration (verified, §9) | Phase C (separate PR) |
| RB-D3 | Restrict role access to non-application databases where safely supported: `PUBLIC` loses `CONNECT`/`TEMPORARY` on the application database and `CONNECT` on `postgres`/`template1`; only the two login roles may connect. Superusers (Railway's tooling, break-glass) are not affected | Phase A A2; V11; CI |
| RB-D4 | Passwords only through psql `\password`; never in SQL, source, logs, gate files, chat or CI | Phase B |
| RB-D5 | The runtime keeps `DELETE` on existing application tables (the application deletes rows); never on SIG objects | Phase A A4; V07/V09 |
| RB-D6 | Schema freeze during the transition, or every intervening migration carries explicit grants | §10 |
| RB-D7 | **Deferred:** no `CONNECTION LIMIT` until a value can be justified operationally | — |

## 4. Stop conditions (production)

STOP, change nothing further, and report to the owner when:

1. any file raises a **`G2-STOP`** exception, or any command exits non-zero;
2. a SQL file's SHA-256 inside the container differs from the merged file's (§6 transport);
3. the Step 1 preflight differs from the expectations in §6;
4. R-E4 is not met: no fresh dump, the dump cannot be transported intact, the isolated restore fails, or the row counts do not reconcile;
5. a step would expose a secret (password, hash, token, connection string), or statement logging would record one (P19);
6. Phase A hits `lock_timeout` or a deadlock **twice** (once: wait and retry once);
7. any verification row (V01–V12) is `FAIL`;
8. after Phase D, the API is unhealthy or logs `permission denied`;
9. any change outside Gate 2 scope appears necessary: SIG tables, RLS, staff credentials or sessions, STAFF code;
10. the next step has not been **explicitly authorized** by the owner.

## 5. Entry criteria (all before Step 2)

E1 owner opening instruction · E2 CI on PostgreSQL 18, merged and green · E3 read-only pre-check · E4 backup/restore
capability (Railway backup VERIFIED; plus R-E4 inside the window) · E5 maintenance window agreed · E6 this runbook merged,
with the PostgreSQL 18 privilege suites green in CI. Record the merged commit SHA before starting.

## 6. Procedure

### Transport: how a SQL file reaches production

Production has no public database endpoint. Each file therefore travels base64-encoded through `railway ssh` into the
`Postgres` container. `psql` there uses the container's own `PG*` environment, so no credential is typed or printed.
Run from a checkout of the merged commit, in Git Bash, in `db/privileges/`. For a file `F`:

```bash
sha256sum "$F"
```
```bash
B64=$(base64 -w0 "$F")
```
```bash
railway ssh -p <project> -s Postgres -e production -- "echo $B64 | base64 -d | sha256sum"
```
The two hashes must be identical (stop condition 2). The `psql` invocations below are executed as
`railway ssh -p <project> -s Postgres -e production -- "echo $B64 | base64 -d | <psql invocation>"`.

| Kind | psql invocation (stdin = the file) |
|---|---|
| read-only (`00`, `20`, `30`) | `PGOPTIONS='-c default_transaction_read_only=on' psql -X -v ON_ERROR_STOP=1 -P pager=off -d railway -c 'BEGIN TRANSACTION READ ONLY' -f - -c 'ROLLBACK'` |
| write (`10`, `90`) | `psql -X -v ON_ERROR_STOP=1 -d railway -f -` |

### Step 0 — Open the window (owner)
Record the start time, operator and runbook commit SHA in the gate-02 `SESSION_LOG.md`.

### Step 1 — Read-only preflight: `00_preflight_readonly.sql` (owner, or Claude when authorized)
**Expected** (the 2026-10-05 pre-check; anything else is a STOP):
- P1: PostgreSQL 18.x.
- P2: only `postgres`.
- P4: API connections as `postgres`.
- P6: 33 tables and 32 sequences, all owned by `postgres`.
- P8: 4 application functions plus 31 `pg_trgm`, none `SECURITY DEFINER`.
- P10: migrations all clean, with the count matching `prisma/migrations`.
- P11: no default privileges.
- P12: 0 RLS, 0 ACLs, 0 triggers.
- P15: 20 enum types owned by `postgres`.
- P16: no Gate 2 roles.
- P17: no `sig_*` objects.
- P18: database ACLs NULL.
- P19: `log_statement = none`, `password_encryption = scram-sha-256`.

### Step 2 — R-E4: fresh dump + verified isolated restore (owner) — see §8
Phase A may start only when §8 has completed successfully **inside this window**.

### Step 3 — Phase A: `10_phase_a_boundary.sql` (owner, write)
Expected output: `BEGIN` … `COMMIT`, no error.
- Ownership changes hold `ACCESS EXCLUSIVE` locks on each table until `COMMIT`. Expect a stall of about a second.
- `lock_timeout = 5s` makes it fail fast and roll back instead of queueing.

Then `20_verify_readonly.sql` (read-only). Expected: V01–V12 `PASS`. V13 `INFO` still shows `postgres` connections; the API
is unaffected until Phase D.

### Step 4 — Phase B: credentials (owner only, RB-D4)
1. Generate two strong, distinct passwords in a password manager. They never leave it, except into psql's hidden prompt and Railway's variable editor.
2. Open an **interactive** session: `railway ssh -p <project> -s Postgres -e production`, then `psql -X -d railway`, and run:
   ```
   \password migration_owner
   \password runtime_app_public
   ALTER ROLE migration_owner LOGIN;
   ALTER ROLE runtime_app_public LOGIN;
   ```
   `\password` computes the SCRAM verifier client-side, so the plaintext never reaches the server, a log or psql's history. Never use `ALTER ROLE … PASSWORD '…'`.
3. In Railway → `myandijan-api` → Variables, compose `MIGRATION_DATABASE_URL` for `migration_owner`, using the `Postgres` service's internal host and port and database `railway`.
4. **Do not change `DATABASE_URL` yet.**

### Step 5 — Phase C: migrations as `migration_owner` (owner)
1. With `MIGRATION_DATABASE_URL` present on `myandijan-api` (Step 4), merge the **Phase C PR**, which adds `directUrl = env("MIGRATION_DATABASE_URL")`.
   **Order matters.** `prisma migrate deploy` (Railway's pre-deploy command) fails with `P1012 Environment variable not found` while the variable is missing, and that blocks every deploy.
2. The resulting deploy's pre-deploy log must show `prisma migrate deploy` succeeding, as `migration_owner`. This is G2-C3.

### Step 6 — Phase D: runtime leaves the superuser (owner)
1. In Railway → `myandijan-api` → Variables, set `DATABASE_URL` to the `runtime_app_public` URL. This redeploys the service.
2. Health: `GET /categories` returns 200.
3. The deploy and runtime logs show no `permission denied` and no Prisma connection errors.

### Step 7 — Phase E: verification (Claude, read-only, when authorized)
- `20_verify_readonly.sql`: V01–V12 `PASS`, and V13 lists **only** `runtime_app_public` (plus the verifying session's role). This is G2-C6.
- `00_preflight_readonly.sql` P2/P4 confirm the role catalog and connections.
- Evidence goes into the gate-02 files.

### Step 8 — Close the window (owner)
Record the end time and outcome. The owner reviews and closes Gate 2. Gate 2 is never closed automatically.

## 7. Rollback

| Reached | Rollback (owner, break-glass, recorded) |
|---|---|
| Phase A failed | Nothing to do: the transaction rolled back (`G2-STOP …` / lock timeout) |
| After Phase A, before Phase B | Run `90_rollback_phase_a.sql` (write). Ownership returns to the superuser, grants are revoked, PUBLIC database access is restored, and the roles are dropped. Or simply leave the roles: services still connect as `postgres` |
| After Phase B, before Phase D | `ALTER ROLE migration_owner NOLOGIN; ALTER ROLE runtime_app_public NOLOGIN;`, remove the new Railway variables, then the Phase A rollback if wanted |
| After Phase C | Revert the Phase C PR, **or** point `MIGRATION_DATABASE_URL` at the previous (superuser) connection, temporarily and recorded |
| After Phase D | Set `DATABASE_URL` back to the previous value (break-glass, recorded); the service redeploys. Then proceed as above if a full rollback is wanted |

`90_rollback_phase_a.sql` refuses while any Gate 2 role can log in or is connected, and once `sig_*` objects exist
(after Gate 3 it no longer applies). **A backup restore is never the rollback for Gate 2.** Restoring replaces production
data; it is a last resort for data loss only, by explicit owner decision.

## 8. R-E4 — fresh dump and independently verified restore (owner)

The dump contains production personal data and credential hashes. **Store it only in owner-controlled, encrypted
storage.** Never put it in a repository folder, a synced folder without encryption, chat, CI, gate files or logs.
Delete it when the owner's retention decision says so.

1. **Dump** (read-only for production; one consistent snapshot). The base64 transport is immune to terminal line-ending translation over `railway ssh`:
   ```bash
   railway ssh -p <project> -s Postgres -e production -- "pg_dump -Fc -d railway | base64 -w 76" > railway-<stamp>.dump.b64
   ```
2. **Row counts on production, right after the dump:** `30_rowcounts_readonly.sql`, read-only, via the §6 transport, with `-At` added to the psql invocation and the output redirected to `prod.counts`.
3. **Decode and fingerprint locally:**
   ```bash
   base64 -d -i railway-<stamp>.dump.b64 > railway-<stamp>.dump
   ```
   ```bash
   sha256sum railway-<stamp>.dump
   ```
   ```bash
   pg_restore --list railway-<stamp>.dump > /dev/null
   ```
   The table of contents must be readable. Record the SHA-256 and size in the gate log; they are not secrets.
4. **Restore into a disposable PostgreSQL 18 instance, never production.** Use a throwaway local cluster: `initdb` in a temporary folder, its own port, listening on localhost only. Then:
   ```bash
   createdb -h localhost -p <port> -U postgres restore_check
   ```
   ```bash
   pg_restore -h localhost -p <port> -U postgres --exit-on-error --single-transaction --no-owner --no-privileges -d restore_check railway-<stamp>.dump
   ```
5. **Verify:**
   ```bash
   psql -X -At -h localhost -p <port> -U postgres -d restore_check -f 30_rowcounts_readonly.sql > restore.counts
   ```
   ```bash
   diff prod.counts restore.counts
   ```
   - `_prisma_migrations` must match exactly, and so must the number of tables.
   - Per-table counts must match. The only exception is a table written to between the dump and the count, and any such difference must be explained, otherwise repeat from step 1.
6. **Destroy the restored copy** (stop the cluster, delete its folder), record R-E4 = met in the gate log, then continue with Phase A.

**Rehearsed** on PostgreSQL 18.4 with synthetic data (2026-10-05):
- dump → base64 with injected CRLF → decode → TOC check → single-transaction restore → identical counts on 33 tables.
- **The production transport over `railway ssh` itself is NOT VERIFIED until the window.** If it fails, STOP; do not improvise another channel.

## 9. RB-D2 verification — how migrations get their own role

Verified 2026-10-05 against this repository (Prisma 5.22, PostgreSQL 18):
- `railway.json` runs `npx prisma migrate deploy` as the **pre-deploy command** of the API service. Prisma uses `directUrl` for migrations and `url` for the application client.
- With `directUrl = env("MIGRATION_DATABASE_URL")`:
  - `prisma generate` (the build) works without the variable.
  - The application client works without it.
  - `prisma migrate deploy` **fails with P1012** without it. Hence the Phase C ordering in Step 5.
- With `DATABASE_URL` = `runtime_app_public` and `MIGRATION_DATABASE_URL` = `migration_owner` on a Phase A database:
  - a new migration applied as `migration_owner` and was recorded in `_prisma_migrations`;
  - the new table belonged to `migration_owner`, and its explicit grants reached the runtime.
- With both URLs = `runtime_app_public`, the deploy was refused: `permission denied for table _prisma_migrations`.

**Residual risk R-G2-1 (recorded for the owner):**
- Railway's pre-deploy command runs with the API service's variables. So `MIGRATION_DATABASE_URL` is also present in the running API's environment.
- Code execution inside the API could therefore read the migration credential, which grants DDL, though never superuser.
- Removing this needs a separate migration service or job. That's a later decision, outside Gate 2.

## 10. Rules for every later migration (RB-D1, RB-D6)

- A migration that creates a table the API uses must grant it explicitly, in the same `migration.sql`:
  ```sql
  GRANT SELECT, INSERT, UPDATE, DELETE ON "new_table" TO runtime_app_public;
  GRANT USAGE, SELECT ON SEQUENCE "new_table_id_seq" TO runtime_app_public;
  ```
  Prisma does not generate these lines; add them by hand. Without them the runtime gets `permission denied`: it fails closed.
- **Never** grant anything on a `sig_*` object to `runtime_app_public`. Every `sig_*` function must `REVOKE EXECUTE … FROM PUBLIC`, because PostgreSQL grants `EXECUTE` to `PUBLIC` by default.
- Never `ALTER DEFAULT PRIVILEGES` for `runtime_app_public`.
- **Schema freeze (RB-D6):** no migration is merged between Phase A and the end of Phase E unless it carries the grants above.
- **Environments without the roles:**
  - A migration containing `GRANT … TO runtime_app_public` needs the Gate 2 roles to exist.
  - In CI they exist only inside the privilege suites. So before the first such migration is merged, the default `test:db` setup must apply Phase A first.
  - Local development databases need the same: run `10_phase_a_boundary.sql` once on the dev database.

## 11. What CI proves (PostgreSQL 18.6, every PR)

`npm run test:db` → `test/db/privilege-boundary.db-spec.ts`, on a throwaway database built from every migration:

1. The preflight runs read-only.
2. Phase A stops atomically on an unexpected state.
3. Phase A applies and its self-check passes.
4. Every V01–V12 check passes.
5. The role attributes are correct.
6. Ownership moved for application objects only.
7. The runtime can do DML and call the search functions.
8. The runtime is refused `TRUNCATE`, DDL, enum changes, `_prisma_migrations`, `TEMP` and role creation.
9. The runtime has no membership in any other role.
10. `migration_owner` can do the DDL a migration needs.
11. RB-D1 fails closed: an ungranted new table makes V07 fail, and explicit grants fix it.
12. INV-DB2: a `sig_*` function executable through PUBLIC, or a granted `sig_*` table, makes V09 fail.
13. RB-D3 connection rules hold.
14. Phase A refuses to run twice.
15. The rollback refuses while a role can log in.
16. The rollback restores the original state, and Phase A re-applies cleanly.
17. The R-E4 row-count query runs read-only.

`npm run test:db:runtime` re-runs the application suites with the application client connected as `runtime_app_public`
after Phase A (G2-C2). It fails the run if the client is not that role.

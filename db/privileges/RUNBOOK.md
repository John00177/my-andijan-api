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
2. a SQL file's SHA-256 differs from its fingerprint in the §6 table, locally or inside the container (the transport guard prints `G2-STOP transport`), or a transport command is 7,500 characters or longer (§6 transport);
3. the Step 1 preflight differs from the expectations in §6;
4. R-E4 is not met: no fresh dump, the dump cannot be transported intact, the isolated restore fails, or the row counts do not reconcile;
5. a step would expose a secret (password, hash, token, connection string), or statement logging would record one (P19);
6. Phase A hits `lock_timeout` or a deadlock **twice** (once: wait and retry once);
7. any verification row (V01–V12) is `FAIL`;
8. after Phase D, the API is unhealthy or logs `permission denied`;
9. any change outside Gate 2 scope appears necessary: SIG tables, RLS, staff credentials or sessions, STAFF code;
10. the next step has not been **explicitly authorized** by the owner;
11. the R-E4 write pause (§8) cannot be established or verified, or the resume does not return to the recorded deployment:
    - P4 is not 0 rows;
    - an API deployment or build is present or appears;
    - the health check still answers;
    - after the Remove, the recorded deployment is not `REMOVED`, is missing from the deployment history, or has no Rollback action;
    - after the Rollback, the API is not on the recorded deployment, or not healthy.

## 5. Entry criteria (all before Step 2)

E1 owner opening instruction · E2 CI on PostgreSQL 18, merged and green · E3 read-only pre-check · E4 backup/restore
capability (Railway backup VERIFIED; plus R-E4 inside the window) · E5 maintenance window agreed · E6 this runbook merged,
with the PostgreSQL 18 privilege suites green in CI. Record the merged commit SHA before starting.

## 6. Procedure

### Transport: how a SQL file reaches production (F-6)

Production has no public database endpoint, and **`railway ssh` truncates a command at about 8 KB**. That was observed
on 2026-10-05: a longer command arrived cut short, and nothing after the cut ran.
- In plain base64, `10_phase_a_boundary.sql` alone is about 24.6 KB.
- So each SQL file travels **gzip-compressed and base64-encoded inside one command**.
- It is decompressed in the `Postgres` container and executed **only if** the SHA-256 of the decompressed SQL equals its fingerprint below.
- `psql` there uses the container's own `PG*` environment, so no credential is typed or printed.
- The container's `gzip`/`gunzip` was confirmed during the 2026-10-05 E3 preflight.

**Expected fingerprints.** SHA-256 of the exact committed bytes, with LF line endings, as merged on `main`. CI fails if
this table and the files ever disagree (`test/db/runbook-transport.db-spec.ts`).

| File | SHA-256 |
|---|---|
| `00_preflight_readonly.sql` | `9e39c5f04721f093b7a1446a155cb5f2c2a90ffee3b2c22b6a36e4f57d3edd28` |
| `10_phase_a_boundary.sql` | `25c0478c923bf3429bc49d2240e61a990c3b347236e43e5a31654ccf312ea6cb` |
| `20_verify_readonly.sql` | `fb07a72dbfbd824614d8f488f99dfd86318a118e216fb17248343cca43d12070` |
| `30_rowcounts_readonly.sql` | `fa806fc40637fce70dc483c8b2f1e833a51a90ffbbe114ac8a7a64082a002da4` |
| `90_rollback_phase_a.sql` | `b9f55bb81c5396ba111bf18d1d9f018bd465e42ab90acd49755a19104a423201` |

**Procedure, for one file `F`.** Run in Git Bash, in any clone of this repository.

1. Set the file and the merged commit recorded at Step 0:
   ```bash
   F=10_phase_a_boundary.sql; REV=<merged commit SHA>; EXPECTED=<fingerprint of F from the table>; T=$(mktemp -d)
   ```
2. Take the **exact committed bytes**, never a working-tree copy. A Windows checkout can have CRLF line endings, which change the fingerprint:
   ```bash
   git show "$REV:db/privileges/$F" > "$T/$F"
   ```
3. Check the fingerprint locally. Anything but `MATCH` is a STOP (stop condition 2):
   ```bash
   [ "$(sha256sum < "$T/$F" | cut -c1-64)" = "$EXPECTED" ] && echo MATCH || echo "G2-STOP local fingerprint"
   ```
4. Compress the exact file and base64-encode the compressed payload:
   ```bash
   GZ=$(gzip -9 -n -c "$T/$F" | base64 -w0)
   ```
5. Build the guarded command. `<psql invocation>` comes from the table below. The guard decompresses the payload in the container, hashes it, and runs `psql` only when the hash equals `EXPECTED`. Otherwise it prints `G2-STOP transport` and exits 3 without touching the database:
   ```bash
   CMD="P=$GZ; if [ \"\$(echo \$P | base64 -d | gunzip | sha256sum | cut -c1-64)\" = $EXPECTED ]; then echo \$P | base64 -d | gunzip | <psql invocation>; else echo 'G2-STOP transport: SHA-256 mismatch, nothing executed'; exit 3; fi"
   ```
6. Check the length. It must be **below 7,500**; otherwise STOP. A command the transport cut short could only run an assignment, never `psql`, but do not rely on that:
   ```bash
   echo ${#CMD}
   ```
7. **Optional, recommended before every write file:** a dry transport. Use the same `CMD` with `<psql invocation>` replaced by `wc -c`; it prints the byte count without touching the database.
8. Run:
   ```bash
   railway ssh -p <project> -s Postgres -e production -- "$CMD"
   ```

| Kind | psql invocation (stdin = the decompressed, verified file) |
|---|---|
| read-only (`00`, `20`, `30`) | `PGOPTIONS='-c default_transaction_read_only=on' psql -X -v ON_ERROR_STOP=1 -P pager=off -d railway -c 'BEGIN TRANSACTION READ ONLY' -f - -c 'ROLLBACK'` |
| write (`10`, `90`) | `psql -X -v ON_ERROR_STOP=1 -d railway -f -` |

`00_preflight_readonly.sql` brings its own `BEGIN TRANSACTION READ ONLY … ROLLBACK`. With the read-only invocation, psql
then reports the outer `BEGIN`/`ROLLBACK` as warnings ("already"/"no transaction in progress"). These are not errors.

Measured command lengths for the files above, without the project placeholder:

| File | Command length |
|---|---|
| `00` | 3,451 |
| `10` | 6,031 |
| `20` | 4,211 |
| `30` | 1,407 |
| `90` | 2,691 |

These were measured on 2026-10-05 with the step 5 command and its psql invocation. All are below the limit. CI checks
every file's command length.

The procedure was proven on 2026-10-05 against a disposable PostgreSQL 18 cluster, with the container emulated by
`sh -c`, as the step 5 command:
- read-only runs (`00`, `20`, `30`) and write runs (`10`, `90`) executed only after a fingerprint match;
- a tampered fingerprint printed `G2-STOP transport` and exited 3, creating no role;
- a command cut short ran no SQL;
- Phase A, then V01–V12 `PASS`, then rollback, all worked through it.

### Step 0 — Open the window (owner)
Record the start time, operator and runbook commit SHA in the gate-02 `SESSION_LOG.md`. A window that includes R-E4
starts with §8 W0: record the live API deployment and declare the merge/deploy freeze.

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
- P14 and P18 (F-7): **exactly** these four databases with these ACLs. Any other database, or any other ACL value, is a STOP:

  | Database | Expected ACL |
  |---|---|
  | `postgres` | NULL (built-in default: PUBLIC may CONNECT and create TEMP tables) |
  | `railway` | NULL (built-in default: PUBLIC may CONNECT and create TEMP tables) |
  | `template0` | `{=c/postgres,postgres=CTc/postgres}`, PostgreSQL's standard `initdb` ACL (PUBLIC may only CONNECT) |
  | `template1` | `{=c/postgres,postgres=CTc/postgres}`, PostgreSQL's standard `initdb` ACL (PUBLIC may only CONNECT) |
- P19: `log_statement = none`, `password_encryption = scram-sha-256`.

### Step 2 — R-E4: fresh dump + verified isolated restore (owner) — see §8
R-E4 runs under the §8 write pause (W0–W9). Phase A may start only when §8 has completed successfully **inside this
window**.

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

The dump contains production personal data and credential hashes. **Everything R-E4 produces stays in one directory on
owner-controlled, encrypted storage, `R_E4_DIR`**:
- the framed stream;
- the decoded dump;
- both count files;
- the disposable restore cluster's data directory and its log.

Never put any of it in a repository folder, an unencrypted synced folder, chat, CI, gate files or logs. The encrypted
dump is kept according to the owner's retention decision, at least until Gate 2 closes, since it is Phase A's recovery
point. The restore cluster is always destroyed.

**Tools** in `db/privileges/r-e4/`. Run them in Git Bash from a clone of the repository at the merged commit.
`.gitattributes` keeps their line endings LF.

| File | Runs where | Purpose |
|---|---|---|
| `remote-dump.sh` | production container, via `railway ssh` (read-only) | `pg_dump -Fc`, base64-encoded between per-run markers, followed by the remote line count and `pg_dump`'s exit status (I-2, I-3) |
| `unframe-dump.sh` | owner's machine | accepts the stream only if exactly this run's frame is present, intact and with `pg_dump_exit=0`; then decodes it (I-2, I-3) |
| `counts.sh` | owner's machine | one deterministic `table\|count` format for production and restore, and the comparison (I-1) |
| `restore-check.sh` | owner's machine | restore into a disposable PostgreSQL 18 cluster, then counts, with guaranteed cleanup (I-4) |

The production command is pinned like the SQL files: SHA-256 of the committed bytes. CI fails if this table and the file
disagree (`test/db/r-e4.db-spec.ts`).

| File | SHA-256 |
|---|---|
| `r-e4/remote-dump.sh` | `18f0d33d7cbb23f5c0bd4d13966a4c90ca8272afc472b2eec50af9560288f724` |

**Prerequisites, all supplied by the owner:**
- the agreed window (E5), with the Step 1 preflight passed inside it;
- the operator;
- `R_E4_DIR` on encrypted storage, with enough free space (the last volume backup was about 119 MB);
- PostgreSQL **18.6** binaries in `PG18_BIN`: the prepared installation `D:/PostgreSQL-18.6/pgsql/bin` (owner decision, 2026-10-06; PATH is not used).
  - **Always export `PG18_BIN` explicitly** (step 1). `restore-check.sh`'s built-in fallback, `D:/PostgreSQL/bin`, is not the approved installation and must not be relied on.
  - `restore-check.sh` itself checks only the major version. So the operator checks the minor: `"$PG18_BIN/postgres" --version` must print 18.6, otherwise STOP;
- a free private port in `R_E4_PORT` (default 55499);
- the `railway` CLI logged in with its registered SSH key;
- the merged commit `REV`;
- the retention decision;
- the merge/deploy freeze and the write pause below (owner decision, 2026-10-06).

### Write pause and resume (owner decision, 2026-10-06)

R-E4 runs with **application writes paused**. The dump and the production counts are then taken while nothing can
write, so the restore can be compared exactly, and a failed check can be repeated against the same unchanged data.

**Why stopping the API is enough.** Verified 2026-10-06, read-only, against the running deployment and Railway's
production environment:
- The API service `myandijan-api` is the **only application that writes** to the database. It runs **one replica**, in one region.
- There are **no workers, cron jobs, queues or webhooks**:
  - no Railway service besides `Postgres` and the API;
  - no scheduler or queue package;
  - no timers in the code.
- The frontend only calls the API. Image uploads go to Supabase storage, not to this database.
- Writes are not limited to POST, PUT, PATCH and DELETE:
  - **`GET /me/health-score` writes**: it computes and stores a missing score;
  - a failed password-reset SMS is recorded after the response has been sent.

  So the pause must stop the whole API; blocking the write methods would not be enough.
- **Stopping the API therefore blocks every application-originated write.** It also stops reads: the API is unavailable for the whole pause.
- P4 of `00_preflight_readonly.sql` excludes the operator's own database session (`pid <> pg_backend_pid()`). P4 with **0 rows** therefore means no other client is connected.
- **Production can be behind `main`.** On 2026-10-06 it was: the running deployment predated several merged PRs.
  - This is intentionally **not** corrected during R-E4: the resume returns to the exact deployment recorded at W0.
  - Deploying `main` is a separate decision, authorized separately.

**Recorded production deployment.** At W0 the operator reads these values from Railway and records them in the gate-02
`SESSION_LOG.md`. W7 and W8 use exactly the recorded values. They are never written into this file.

| Item | Value |
|---|---|
| Service | `myandijan-api` (production), 1 replica |
| Deployment | `<RECORDED_DEPLOYMENT_ID>` |
| Commit | `<RECORDED_COMMIT_SHA>` |
| Health check | `GET /categories` on `https://myandijan-api-production.up.railway.app` |

**Never during the window:**
- a Redeploy, a deployment of `main`, a replacement deployment, or any merge to `main`;
- a database configuration change, such as a read-only setting;
- terminating or cancelling database sessions;
- a migration, a privilege change, a variable change, or an emergency code change.

If sessions remain after the pause, STOP. Do not terminate them.

**Window sequence.** The owner authorizes each production action; Claude runs the read-only checks.

| Step | Who | Action | Pass condition |
|---|---|---|---|
| W0 | owner | Record the live API deployment as `<RECORDED_DEPLOYMENT_ID>` / commit `<RECORDED_COMMIT_SHA>` in `SESSION_LOG.md`. Declare the **merge/deploy freeze**: no merge to `main` and no deployment of `main` for the whole window | Exactly one active `myandijan-api` deployment, `SUCCESS`, 1 replica; its ID and commit are recorded |
| W1 | Claude (read-only) | Preflight: `00_preflight_readonly.sql`, then `30_rowcounts_readonly.sql` with the step 4 `-At` invocation, both through the §6 transport | The §6 Step 1 expectations hold; P4 shows the API's connections, all `postgres` (12 idle on 2026-10-06); the counts normalize |
| W2 | owner | **Pause:** in Railway → `myandijan-api` → Deployments, on the active deployment, ⋮ → **Remove** | — |
| W3 | Claude (read-only) + owner | **Verify the pause:** run `00` again; check Railway; call the health check | P4 returns **0 rows**, and everything else is unchanged from W1; Railway shows **no** active, building or deploying `myandijan-api` deployment; the recorded deployment `<RECORDED_DEPLOYMENT_ID>` is in state **`REMOVED`**, is **still present in the deployment history**, and **still offers ⋮ → Rollback**; the health check does **not** answer 200. Otherwise **STOP R-E4**: do not continue to W4, and do **not** proceed automatically to W7; resume (W7, W8) only on the owner's **explicit confirmation** (failure handling below) |
| W4 | owner + Claude | R-E4 steps 1–4: set up, pin `remote-dump.sh`, dump, production counts | Each step's own checks. Otherwise **STOP R-E4**: a partial or failed dump is not used; do **not** proceed automatically to W7 and do **not** roll back automatically; resume (W7, W8) only on the owner's **explicit confirmation** (failure handling below) |
| W5 | Claude (read-only) + owner | **Re-verify the pause immediately:** run `00` again; check Railway | P4 still returns **0 rows**, and **no** deployment or build has appeared. Otherwise **STOP R-E4**: the dump is not used; do **not** proceed automatically to W7 and do **not** roll back automatically; resume (W7, W8) only on the owner's **explicit confirmation** (failure handling below) |
| W6 | owner + Claude, local | R-E4 steps 5–6: unframe and decode; `"$PG18_BIN/postgres" --version`; `restore-check.sh` | `unframe-dump.sh` succeeds; the version is 18.6; `restore-check.sh` exits **0**. Otherwise **STOP R-E4**: do **not** proceed automatically to W7 and do **not** roll back automatically; resume (W7, W8) only on the owner's **explicit confirmation** (failure handling below) |
| W7 | owner | **Resume**, only on the owner's **explicit authorization:** in Railway → `myandijan-api` → Deployments, select the recorded removed deployment `<RECORDED_DEPLOYMENT_ID>` and use ⋮ → **Rollback** on that deployment. **Never Redeploy** (it rebuilds), **never deploy `main`**, and **never substitute another deployment** | Verify the resulting active deployment: it comes from the Rollback of `<RECORDED_DEPLOYMENT_ID>`, not from a new build, and runs commit `<RECORDED_COMMIT_SHA>` (checked in full at W8) |
| W8 | Claude (read-only) + owner | **Verify the resume:** check Railway; call the health check; run `00` again | The active deployment is `SUCCESS` on commit `<RECORDED_COMMIT_SHA>`; the health check answers **200**; P4 shows `postgres` connections again (at least one; the pool grows with traffic) and no drift from W1. Otherwise apply the failure handling below |
| W9 | owner | Lift the merge/deploy freeze, and record the end time (step 7) | — |

**Failure handling:**
- **A STOP before W2:** nothing was paused, so no resume is needed.
- **A STOP at W3:** R-E4 stops and is not met. Do not continue to W4, and do **not** proceed automatically to W7.
  Report to the owner; W7 and W8 run only on the owner's **explicit confirmation**. If the recorded deployment is
  not `REMOVED`, is missing from the deployment history, or has no Rollback action, also: do not deploy `main`, do
  not create a replacement deployment, and do not improvise a recovery path. The hard stop still holds: no
  production remediation, SQL privilege change, credential or variable change, migration or emergency code change.
- **A STOP at W5** (database sessions, or an API deployment that is active, building or deploying, reappeared after
  the dump): R-E4 stops and is not met; the dump is not used. Do **not** proceed automatically to W7 and do **not**
  roll back automatically. Report to the owner; W7 and W8 run only on the owner's **explicit confirmation**. The
  hard stop still holds: no production remediation, SQL privilege change, credential or variable change, migration,
  emergency code change or replacement deployment.
- **A STOP at W4** (set-up, pin, dump or production counts failed): R-E4 stops and is not met; a partial or failed
  dump is not used. Do **not** proceed automatically to W7 and do **not** roll back automatically. Report the
  failure to the owner; W7 and W8 run only on the owner's **explicit confirmation**. The hard stop still holds: no
  production remediation, SQL privilege change, credential or variable change, migration, emergency code change or
  replacement deployment.
- **A STOP at W6** (unframe, version check or restore check failed): R-E4 stops and is not met. Do **not** proceed
  automatically to W7 and do **not** roll back automatically. Report the failure to the owner; W7 and W8 run only on
  the owner's **explicit confirmation**. The hard stop still holds: no production remediation, SQL privilege change,
  credential or variable change, migration, emergency code change or replacement deployment.
- **W7 itself** always runs only on the owner's **explicit authorization**.
- **The Rollback (W7) fails, or W8 fails:** roll back to the same deployment again.
- **That also fails:** the API stays down. STOP and report to the owner. Still no Redeploy, no deployment of `main`, no replacement deployment, and no production remediation, migration, SQL privilege change or emergency code change in this window.

1. **Set up** (Git Bash, at the repository root). Set `R_E4_ENCRYPTED_STORAGE_CONFIRMED=yes` only after confirming the folder is encrypted; `restore-check.sh` refuses without it:
   ```bash
   export R_E4_DIR=<encrypted folder> R_E4_ENCRYPTED_STORAGE_CONFIRMED=yes PG18_BIN=D:/PostgreSQL-18.6/pgsql/bin; REV=<merged commit SHA>; STAMP=$(date +%Y%m%d-%H%M); NONCE=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
   ```
2. **Pin the production command.** Use the exact committed bytes and the fingerprint from the table above. Anything but `MATCH` is a STOP:
   ```bash
   git show "$REV:db/privileges/r-e4/remote-dump.sh" > "$R_E4_DIR/remote-dump.sh"
   ```
   ```bash
   [ "$(sha256sum < "$R_E4_DIR/remote-dump.sh" | cut -c1-64)" = 18f0d33d7cbb23f5c0bd4d13966a4c90ca8272afc472b2eec50af9560288f724 ] && echo MATCH || echo "G2-STOP remote-dump fingerprint"
   ```
   ```bash
   REMOTE=$(sed "s/@NONCE@/$NONCE/g" "$R_E4_DIR/remote-dump.sh" | tr -d '\r\n'); echo ${#REMOTE}
   ```
   The command is about 300 characters, far below the §6 transport limit.
3. **Dump.** Read-only for production: one consistent `pg_dump` snapshot, and nothing is written in the container.
   ```bash
   railway ssh -p <project> -s Postgres -e production -- "$REMOTE" > "$R_E4_DIR/railway-$STAMP.framed"
   ```
   The stream is:
   - `G2RE4-BEGIN <nonce>`;
   - the base64 lines, 76 characters each;
   - `G2RE4-COUNT <nonce> <number of lines>`;
   - `G2RE4-END <nonce> pg_dump_exit=<status>`, printed only after `pg_dump` and the encoder have finished.
4. **Row counts on production, right after the dump (I-1).** Run `30_rowcounts_readonly.sql` through the §6 guarded transport, with this psql invocation (the §6 read-only invocation plus `-At`), and write the output to `$R_E4_DIR/prod.raw`:
   `PGOPTIONS='-c default_transaction_read_only=on' psql -X -At -v ON_ERROR_STOP=1 -P pager=off -d railway -c 'BEGIN TRANSACTION READ ONLY' -f - -c 'ROLLBACK'`

   Then normalize:
   ```bash
   db/privileges/r-e4/counts.sh normalize "$R_E4_DIR/prod.raw" "$R_E4_DIR/prod.counts"
   ```
   `normalize` keeps exactly the `table|count` rows, sorted by table.
   - psql's `BEGIN`/`ROLLBACK` tags, warnings and the CLI notice contain no `|`; they are dropped and counted.
   - Any line with a `|` that is not a well-formed row fails closed, as does a duplicate table or a missing `_prisma_migrations`.
5. **Verify and decode the stream (I-2, I-3):**
   ```bash
   db/privileges/r-e4/unframe-dump.sh "$R_E4_DIR/railway-$STAMP.framed" "$NONCE" "$R_E4_DIR/railway-$STAMP.dump"
   ```
   It succeeds only if all of these hold:
   - this nonce's frame is present exactly once;
   - every line inside the frame is strict base64 of the expected shape;
   - the line count matches;
   - `pg_dump_exit=0`;
   - the decoded data starts like a custom-format archive.

   Lines outside the frame, such as the CLI's "Using SSH key …" notice, are counted but never decoded or shown. On any failure it writes no dump: STOP.

   Record the printed size and SHA-256 in the gate log; they are not secrets.

   `"$PG18_BIN/pg_restore" --list` on the file shows that its table of contents is readable. **It does not prove the dump is complete.** Completeness is proven by the frame (this step) and the full restore (step 6).
6. **Restore check on a disposable PostgreSQL 18 cluster (I-4):**
   ```bash
   db/privileges/r-e4/restore-check.sh "$R_E4_DIR/railway-$STAMP.dump" "$R_E4_DIR/prod.counts"
   ```
   The script, in order:
   1. refuses unless `R_E4_ENCRYPTED_STORAGE_CONFIRMED=yes` and both files are inside `R_E4_DIR`;
   2. checks that `PG18_BIN` is PostgreSQL 18, and that `30_rowcounts_readonly.sql` matches its §6 fingerprint;
   3. refuses if `R_E4_PORT` is already serving PostgreSQL;
   4. `"$PG18_BIN/initdb" -D "$R_E4_DIR/restore-pgdata-<time>" -U postgres -A trust -E UTF8 --locale=C`;
   5. `"$PG18_BIN/pg_ctl" -D <data> -o "-p $R_E4_PORT -c listen_addresses=localhost" -l <data>.log -w start`;
   6. `createdb restore_check`;
   7. `pg_restore --exit-on-error --single-transaction --no-owner --no-privileges -d restore_check`;
   8. `psql -X -q -At -f 30_rowcounts_readonly.sql`;
   9. `counts.sh normalize`, then `compare`.

   A trap **always** runs `pg_ctl … stop` (fast, then immediate) and deletes the data directory and its log, after failures too, and prints `cleanup done`. If the deletion fails, it says so: STOP and delete manually. The server listens on localhost only and exists only while the script runs.

   Exit status:

   | Status | Meaning |
   |---|---|
   | 0 | MATCH |
   | 2 | per-table differences: STOP, unless each is a table written to between the dump and the count, explained and recorded; otherwise repeat from step 3 |
   | 1 | anything else: STOP |

   `_prisma_migrations` and the table set must always match exactly.
7. **Record** in the gate log:
   - times;
   - dump size and SHA-256;
   - the restore-check exit status and table count, and `cleanup done`;
   - the W0–W9 results: the deployment before and after, P4 at W1, W3, W5 and W8, and the health-check results.

   R-E4 is then met, and Phase A may be authorized. Keep the encrypted dump per the retention decision. Delete `remote-dump.sh`, `*.framed` and `*.raw` from `R_E4_DIR` when no longer needed.

Any non-zero exit in steps 2–6 is a STOP (stop conditions 1 and 4).

**Proven locally** on synthetic data (2026-10-06, `test/db/r-e4.db-spec.ts`):
- The production command was run by `sh` with a stand-in `pg_dump`.
- A valid stream, surrounded by a CLI notice and CR line endings, decoded byte for byte.
- The following failed closed with no dump written:
  - noise or an injected marker inside the frame;
  - a stream cut mid-payload or before END;
  - a lost payload line;
  - `pg_dump` exit 1;
  - a foreign or stale nonce;
  - a second frame;
  - a non-archive payload.
- Counts with psql tags and warnings matched clean restore counts.
- A per-table difference gave exit 2.
- A `_prisma_migrations` or table-set difference gave exit 1.
- End to end on PostgreSQL 18.4, with a disposable source cluster built from every migration: real `pg_dump` through `remote-dump.sh`, then unframe, counts, and `restore-check.sh` gave MATCH. A later write gave exit 2. Cleanup left no data directory.

**The production transport over `railway ssh` itself is NOT VERIFIED until the window.** If it fails, STOP; do not
improvise another channel.

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
18. G2-C3 (Phase C): with this repository's `directUrl`, a new migration deploys as `migration_owner` while `DATABASE_URL` is the runtime, and is refused when both URLs are the runtime.

`npm run test:db:runtime` re-runs the application suites with the application client connected as `runtime_app_public`
after Phase A (G2-C2). It fails the run if the client is not that role.

`test/db/runbook-write-pause.db-spec.ts` (part of `test:db`) checks the §8 write pause:
- the W0–W9 order;
- the resume rolls back to the deployment recorded at W0, never by Redeploy, never to `main`, never to a substitute;
- W3 verifies that the removed deployment stays in the history and rollback-eligible;
- a W3, W4, W5 or W6 failure stops R-E4 without an automatic resume or rollback, and W7 runs only on the owner's
  explicit authorization;
- no production deployment ID or commit SHA is hard-coded in the procedure;
- the restore uses the approved PostgreSQL 18.6 binaries, set explicitly and checked by version;
- the window runs only `00` and `30`;
- it contains no database-configuration, session-termination or deployment command;
- P4 excludes the operator's own session;
- the production counts use the §6 read-only invocation plus `-At`.

`test/db/runbook-transport.db-spec.ts` (part of `test:db`) checks the §6 transport (F-6). The fingerprint table must
list every SQL file in this directory with its exact SHA-256 (committed LF bytes), and every file's gzip + base64
transport command must stay below 7,500 characters.

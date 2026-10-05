# CLAUDE.md — My Andijan API

Guidance for Claude Code (and any AI agent) working in this repository.

> **The full handoff documentation for this project lives in the *frontend* repository**, because that is where the Claude Code sessions ran and where the `docs/` tree already existed:
>
> `C:\Users\JKT443\Desktop\myandijan-frontend\docs\my-andijan\`
>
> **Start at `HANDOFF_INDEX.md` there.** It covers both repositories. If you are ChatGPT acting as architect/reviewer, read `CHATGPT_CONTEXT.md` as well. This file is the local working contract.

---

## 1. What this is

The backend for **My Andijan** (`myandijan.uz`) — a multilingual business directory and city guide for the Andijan region of Uzbekistan.

**NestJS 10 + Prisma 5 + PostgreSQL**, deployed on **Railway** at `https://myandijan-api-production.up.railway.app`.

**Scale:** 17 feature modules · **118 routes** · 45 DTOs · **31 database models** · 19 enums · 11 migrations.

Its client is `myandijan-frontend` (React 19 + Vite, on Vercel). **There is no shared type package** — DTOs here and `src/types/index.ts` there are maintained in parallel by hand, so a contract change needs both repos.

---

## 2. Commands

```bash
docker compose up -d
```
```bash
npm run start:dev
```
```bash
npx prisma migrate dev
```
```bash
npm run db:seed
```
```bash
npm run prisma:studio
```
```bash
npm run build
```

- `postinstall` runs `prisma generate`.
- `docker compose` gives you `postgres:16` as `andijan` / `my_andijan` on 5432.
- **`npm run lint` and `npm run format` are broken** — they invoke `eslint` and `prettier`, **neither of which is in `devDependencies`**. Do not rely on them; do not assume lint passed.
- **Tests:** `npm test` runs the unit suites (`src/**/*.spec.ts`, no database). `npm run test:db` runs the real-PostgreSQL suites in `test/db/` (refresh-token sessions and concurrency, migration backfill — Phase 15E.4b). It needs `TEST_DATABASE_URL`: a disposable **local** database whose name contains `test`. The suites truncate tables and refuse anything else. CI runs both inside `test-and-build`, against a throwaway `postgres:18.6-alpine` service container (production runs PostgreSQL 18.6; SIG U14). `docker compose` still uses `postgres:16` for local development: a PostgreSQL 18 image cannot reuse the existing 16 data volume.
- **Database privilege boundary (SIG Gate 2):** `db/privileges/` holds the reviewed production runbook (`RUNBOOK.md`) and its SQL. `test/db/privilege-boundary.db-spec.ts` (part of `test:db`) runs those files unchanged; `npm run test:db:runtime` re-runs the application suites connected as `runtime_app_public`. Both create cluster-wide roles, so run them **only on a disposable cluster with local trust authentication** (CI's container). **Every new migration that creates a table the API uses must `GRANT` it to `runtime_app_public` explicitly, and nothing `sig_*` ever may be** — see `RUNBOOK.md` §10. Executing anything in `db/privileges/` against production requires the owner's explicit authorization.

### Windows shell notes
- Use **`npx.cmd` / `npm.cmd`** in PowerShell — the execution policy blocks `*.ps1` wrapper scripts.
- **PowerShell 5.1 has no `&&`.** Use `;` or separate commands.
- Heredocs break on Uzbek apostrophes (`'`, `’`, `ʻ`, `ʼ`) — write a script file instead.

---

## 3. Layout

```
prisma/
  schema.prisma      ← THE most important file here. 1193 lines, densely commented
                       with the rationale for nearly every non-obvious choice.
  migrations/        ← 11, all additive
  seed.ts            ← Andijan geography + taxonomy + seed admin
  demo-data.ts       ← sample content, run manually
src/
  main.ts            ← bootstrap: global ValidationPipe, CORS, Swagger at /docs
  app.module.ts      ← imports all 17 feature modules
  common/            ← guards (JwtAuthGuard, RolesGuard), decorators, role-hierarchy.ts
  prisma/            ← PrismaService
  auth/              ← JWT + OTP + password reset. BCRYPT_ROUNDS = 12
  users/ geography/ categories/ businesses/ search/ reviews/ favorites/
  events/ products/ owner/ admin/ analytics/ command-center/
  health-score/ upload/ sms/
scripts/
  cleanup-db.ts             ← ⚠️ DESTRUCTIVE. Read it before running.
  promote-super-admin.ts    ← privileged
  seed-role-accounts.js     ← ⚠️ contains a hardcoded credential — see §6
  rename-andijon-district.js
```

Every feature module follows the same shape: `*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/*.dto.ts`.

---

## 4. Conventions

- **One module per feature.** Add it to `app.module.ts`.
- **Validate with `class-validator` DTOs.** The global pipe uses `whitelist: true` and `forbidNonWhitelisted: true`, so an unknown body property returns 400 — never bypass it.
- **Guard with `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(...)`.** `@Roles` declares the **minimum** role (a hierarchy floor), and `getAllAndOverride` lets a method override its controller in either direction.
- **`@CurrentUser()`** supplies the authenticated user.
- **Ownership checks belong in the service**, scoped by `ownerId` — never trust a client-supplied id.
- **Prisma query builder by default.** Raw SQL only where it earns it (search, analytics, command centre), always via `Prisma.sql` tagged templates.
- **Phone format is `/^\+998\d{9}$/`** — enforced in six DTOs.
- **`snake_case` in Postgres, `camelCase` in code**, via `@map`/`@@map`.
- **Comment the *why*.** The schema's rationale comments are this project's most valuable documentation — several decisions survive only there. Match that standard, and **correct a comment when it goes stale** (several in the frontend's `api.ts` did).

---

## 5. Critical constraints — do NOT change without discussion

1. **Vanilla PostgreSQL only.** The schema header states the database must be **relocatable to an Uzbek host** (a data-localization requirement). No PostGIS, no `pgvector`, no proprietary extensions. `pg_trgm` is the sole exception (standard contrib).
2. **`Business` is the brand; `Branch` holds ALL location data** — district, city, address, landmark, phone, lat/lng, hours. Never add location columns to `Business`.
3. **Reviews are branch-scoped; favourites are business-scoped.** Both are enforced by unique constraints with rows behind them.
4. **`BranchHour.dayOfWeek` is `0 = Monday … 6 = Sunday`** — not `Date.getDay()`. The frontend's `schema.org` output depends on it.
5. **`Int @default(autoincrement())` primary keys.** `JwtPayload.sub: number`, the guards and the seed script all assume it.
6. **The role hierarchy is a floor check, not exact match.** Changing that locks `SUPER_ADMIN` out of most routes. `ROLE_HIERARCHY`: `CUSTOMER` 1 < `BUSINESS_OWNER` 2 < `SUPPORT` 3 < `MODERATOR` 4 < `ADMIN` 5 < `SUPER_ADMIN` 6.
7. **`/auth/register` must reject `role=ADMIN`.** The schema says so; `RegisterDto`'s `@IsIn([CUSTOMER, BUSINESS_OWNER])` enforces it. Keep it.
8. **`BusinessRecommendation.code` is the stable rule key** that makes health-score recalculation an idempotent upsert and preserves the owner's `isCompleted` flag. Titles are display copy and cannot serve as the key.
9. **Health scores recompute on write, deliberately not on a cron.** Blend weights live in `HealthScoreService`, not the schema, so they can be tuned without a migration.
10. **The command-centre log tables (`PlatformMetric`, `SearchAnalytics`, `ActivityLog`) intentionally have no foreign keys** — they are high-volume append-only logs, and orphaned references are expected.
11. **`ActivityLog.metadata` stores an `ipHash`, never a raw IP.**
12. **Do not drop `SearchQueryLog`** until the backfill into `SearchAnalytics` is confirmed.
13. **Keep `UploadService` provided directly in `AuthModule`** — importing `UploadModule` there would mount `UploadController` a second time.
14. **`SmsService` must never throw.** An SMS outage must not fail an OTP request whose code has already been persisted.
15. **Route order matters in `AdminController`:** `PATCH /admin/categories/reorder` is declared **before** `PATCH /admin/categories/:id`. Reordering them makes `reorder` unreachable.

---

## 6. Security rules

Full analysis: `SECURITY.md` in the frontend's handoff package.

1. **✅ RESOLVED 2026-09-28 — `scripts/seed-role-accounts.js` reads `process.env.SEED_ROLE_PASSWORD` (no default; exits 1 when unset), the old literal was purged from history before the first push, and the production credential was ROTATED** to a 192-bit random value held in the Railway production variable `SEED_ROLE_PASSWORD` (see `SECURITY.md` §1.1 in the frontend's handoff package). Historically the script held a hardcoded `PLAIN_PASSWORD` — applied to `SUPER_ADMIN` and five other roles, printed to stdout, run against production via `railway ssh`, and re-applied on every run because it uses `upsert`. **Never reintroduce a literal or a default.** Still open (Phase 15E.7, MEDIUM): the six role accounts share that one rotated value.
2. **`SUPABASE_SERVICE_KEY` bypasses Supabase RLS entirely.** Server-side only, always.
3. **Never use `$queryRawUnsafe` / `$executeRawUnsafe`.** Use `Prisma.sql`. `Prisma.raw()` takes hardcoded literals only — never user input. The codebase is currently clean; keep it clean.
4. **Keep `whitelist` + `forbidNonWhitelisted`** on the global pipe.
5. **Keep bcrypt at cost 12** at every hash site.
6. **Never store an OTP, reset code or refresh token in plaintext.** Refresh tokens are `crypto.randomBytes(48)` stored as a SHA-256 hash — they are **not** JWTs, and `JWT_REFRESH_SECRET` is a dead variable that should be removed.
7. **Keep `JwtStrategy`'s per-request `status`/`deletedAt` check** — it is what makes suspension immediate.
8. **Never read, echo or commit `.env`.** It holds the production `DATABASE_URL` and the Supabase service-role key.

### Known open security gaps
`app.enableCors()` has no allow-list · `/docs` is publicly reachable in production · no rate limiting except the hand-rolled OTP cap · `POST /analytics/*` are **unauthenticated writes** · no `helmet` · no global exception filter.

---

## 7. Environment

Read directly from `process.env` — **there is no `@nestjs/config`, no validation, and no boot check.**

**Required:** `DATABASE_URL`, `JWT_ACCESS_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (the last two are required for the API to **boot** — `UploadService`'s constructor throws without them).

**Optional:** `JWT_ACCESS_EXPIRES_IN` (default `15m`), `JWT_REFRESH_EXPIRES_IN` (default `30d`), `PORT` (default 3000), `ESKIZ_BASE_URL`, `ESKIZ_FROM`.

**For real SMS:** `ESKIZ_EMAIL`, `ESKIZ_PASSWORD` — **currently unset on Railway**, so `POST /auth/otp/request` returns success while sending nothing.

**For seeding:** `SEED_ADMIN_PHONE`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_EMAIL`.

> **`.env.example` is incomplete** — it omits all `SUPABASE_*` and `ESKIZ_*`, so onboarding from it produces an API that will not boot. And **`JWT_REFRESH_SECRET` is declared but read by nothing.** Both should be fixed. Details in `ENVIRONMENT.md`.

---

## 8. Deployment

`railway.json`: NIXPACKS, build `npm run build`, start `npx prisma migrate deploy && npm run start:prod`, restart `ON_FAILURE` max 3. Deploy with `railway up --detach`.

Because the start command is **`&&`-chained**, **a running production API proves every prior migration applied cleanly** — useful when reasoning about migration state without database access.

**There is no `/health` endpoint** and never has been. Use `GET /categories` as a liveness probe.

**Deploy the API before the frontend** when a change spans both — the frontend must never ship calls to routes that are not live yet.

---

## 9. Git workflow

`master`, **no remote, no CI, no PR flow.** Commit only when asked. **Run a secret scan before committing** — that is how the credential in §6 was found. **Do not add a remote** without first purging that credential from history.

---

## 10. Before changing anything structural

1. **Read the schema comments** for the models involved. They explain most non-obvious choices, including ones that reversed an earlier draft.
2. **Read `DECISIONS.md`** in the frontend's handoff package — 52 decisions, each marked 🔒 LOCKED / 🔓 REVISITABLE / ⚠️ NEEDS DECISION.
3. **Check `API.md`** for whether an endpoint already exists and whether anything calls it. **~80 of 118 routes have no frontend caller** — including the entire search module, all analytics ingestion, the whole command centre, the health score, and 20 of 31 admin routes. **This backend is generally not the bottleneck.**
4. **Check the ten open questions** at the end of `DECISIONS.md`. Two of them are backend questions: whether `SUPPORT` should outrank `BUSINESS_OWNER`, and whether Uzbek data *residency* (not just portability) is required — the database is currently on Railway.

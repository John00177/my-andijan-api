# CLAUDE.md — my-andijan-api

Claude Code instructions for this repository. **Read [`AGENTS.md`](AGENTS.md) first** — it holds the universal rules (source of truth, Git, production, secrets, reporting). This file adds only what is Claude- and repo-specific.

**My Andijan API**: NestJS 10 + Prisma 5 + PostgreSQL, deployed on Railway (`https://myandijan-api-production.up.railway.app`). Client: `myandijan-frontend` (React + Vite on Vercel). No shared type package — a contract change touches both repos, and the API ships first.

## Before you start

1. **Verify the repository state** — `git fetch`, `git status -sb`, `git log --oneline -5 origin/main`. GitHub is the implementation truth.
2. **Recover context from memory, selectively.** Canonical project memory for both repos lives in the **frontend** repo: `myandijan-frontend/docs/my-andijan/` (GitHub `John00177/myandijan-frontend`; locally `D:\My-Andijan-Work\myandijan-frontend\docs\my-andijan\`). Read `CURRENT_STATE.md` top section only, then the one domain document the task needs (routing: `intelligence/PROJECT_MEMORY.md`; usually `API.md`, `DATABASE.md`, `SECURITY.md`).
3. **Do not reread the whole project history.** Within a session, don't reread what you already read unless it changed.
4. **Before changing architecture, the schema or a locked rule:** `DECISIONS.md`, `ENGINEERING_RULES.md` §1 and §3 (frontend repo), and the rationale comments in `prisma/schema.prisma`.

## This repository

- **Home path: `D:\My-Andijan-Work` only** — `D:\My-Andijan-Work\myandijan-frontend` and `D:\My-Andijan-Work\my-andijan-api`. Do not work in other clones (Desktop, `D:\My-Andijan`, Temp worktrees); `D:\My-Andijan-SAFE` and the SIG gate record are read-only references.
- Commands: `docker compose up -d` then `npm run start:dev`; `npm run build`; `npm test` (unit). `npm run lint` / `format` are **broken** (ESLint/Prettier not installed).
- `npm run test:db` and `npm run test:db:runtime` need `TEST_DATABASE_URL` pointing at a **disposable local** database whose name contains `test`. They truncate tables and create cluster-wide roles — never point them at anything shared or remote.
- **`db/privileges/`** is the reviewed SIG Gate 2 production runbook and SQL. Executing any of it against production requires the owner's explicit authorization. Once Gate 2 resumes and Phase A has run, every new migration that creates a table the API uses must `GRANT` it to `runtime_app_public` (`RUNBOOK.md` §10).
- **SIG Gate 2 is paused (owner, 2026-10-10, D-80): no `GRANT` to `runtime_app_public`** — not in a migration, a script or manual SQL — until the owner resumes Gate 2 and Phase A has run (`db/privileges/RUNBOOK.md` §10).
- **Migrations:** `npx prisma migrate dev` locally only. Never run `migrate deploy`, `db push` or `migrate reset` against a non-local database. Railway runs `prisma migrate deploy` pre-deploy (`railway.json`), so migrations must be backward-compatible.
- Authorization is capability-based, deny by default (`src/authz/`). Every route needs `@Public` / `@Authenticated` / `@RequireCapability`, or CI fails.
- Windows: use `npm.cmd` / `npx.cmd`; PowerShell 5.1 has no `&&`.

## Rules that matter most for Claude

- **Preserve branch protection; never bypass CI.** Branch → PR → `test-and-build` → review. Commit/push only when asked.
- **Never claim deployment unless independently verified** — a Railway deployment record for that exact SHA, plus a live probe for behaviour. **Railway production is currently blocked** (see `CURRENT_STATE.md`); merged API work is not live.
- **No production mutation, no secrets** — see `AGENTS.md`. Never read, echo or commit `.env`.
- **Record durable outcomes in canonical memory** after a major session (`intelligence/MEMORY_CONTRACT.md` §4) — in a `docs/` PR in `myandijan-frontend`, because this repo does not hold the memory. Skip it for trivial work.
- Your conversation and Claude's auto-memory are working memory, not project truth.

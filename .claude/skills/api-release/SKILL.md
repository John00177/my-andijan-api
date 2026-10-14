---
name: api-release
description: Rules for releasing the My Andijan API to Railway production. Use whenever a task mentions deploy, release, Railway, redeploy, rollback, production, or merging anything to my-andijan-api main.
---

# API release — My Andijan (Railway)

**Claude never performs a production step on its own.** Every step marked **[PROD]** needs the owner's explicit approval *of that specific step* in chat (MEMORY_CONTRACT §6.2). Claude prepares, checks read-only, watches and records.

The current release plan, with today's SHAs and deployment ids, is in the frontend repo:
`docs/my-andijan/PHASE_16_DEPLOY_STEPS.md` (owner steps) and `RELEASE_16H_PLAN.md` (detail, evidence list, abort rules). Use those for the current release; this skill holds the rules that apply to every release.

## Facts that make this dangerous

- **Merging to API `main` is a production action.** Auto Deploy is on and Wait for CI (`checkSuites`) is off, so a merge can deploy immediately — including any migration on `main`. No merge to API `main` during a release window.
- The GitHub push trigger has been unreliable; do not count on it either way.
- `railway.json` decides the build (`NIXPACKS`), pre-deploy (`npx prisma migrate deploy`, **no timeout**) and healthcheck (`/categories`, 120 s). The dashboard builder setting is overridden.
- Railway Hobby cannot make backups; the backup is a `pg_dump` with the committed tools in `db/privileges/` (RUNBOOK §8).

## How to deploy (only way)

Deploy **one exact, CI-green commit SHA** to `myandijan-api` / `production` with Railway's deploy-a-specific-commit action (or GraphQL `serviceInstanceDeployV2` with `commitSha`).
**Never:** "Redeploy", `railway up`, a push to trigger it, or the Railway MCP `create-deployment` tool (it creates a new service).

## Order (every release)

1. Read-only re-check: `main` head = the planned SHA, its `test-and-build` passed, current production deployment id, nothing staged.
2. **[PROD read]** Fresh same-day backup + local restore check, SHA-256 recorded.
3. **[PROD read]** Pre-checks: no `idle in transaction` sessions, no locks on the tables the migration touches; run the migration's row-count query.
4. **[PROD write]** Pinned deploy of the SHA.
5. Watch: builder is Nixpacks (abort *while building* if not) → pre-deploy log shows the expected migration count and each new migration applied → healthcheck → `SUCCESS`.
6. Verify with the plan's V-checks; record each with a timestamp. Blank = not verified.
7. Only then merge any frontend PR that depends on the new API.
8. Record in canonical memory (`session-handoff` skill), with deployment id + SHA.

## Abort rules

- **Pre-deploy hangs → do NOT cancel.** A killed client leaves the migration running server-side and it commits later into a split state. Find the blocker read-only (`pg_stat_activity`, `pg_locks`); the owner decides whether to end only that session.
- **Pre-deploy fails** → nothing new is live. Do not retry, do not `prisma migrate resolve` without separate owner approval. Record the `_prisma_migrations` row.
- **Healthcheck or a V-check fails** → Railway **Rollback** to the previous deployment id. Rollback does not undo migrations.

## Evidence

Never say "deployed" or "live" without a Railway deployment record for **that exact SHA** with `SUCCESS`; a behaviour claim also needs a live probe (MEMORY_CONTRACT §5). Merged ≠ deployed.

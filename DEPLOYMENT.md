# Deployment

Production API: `https://myandijan-api-production.up.railway.app` (Railway project
`3910b9c5-e86d-4c06-8058-def605847424`, service `myandijan-api`, environment `production`).

- **Production branch:** `main`. Every push to `main` is deployed automatically by the
  Railway GitHub App, **after** the GitHub Actions `test-and-build` check passes
  ("Wait for CI"). A red CI run does not deploy.
- **CI** (`.github/workflows/ci.yml`) only validates: `npm ci` → `npm test` → `npm run build`.
  It contains no deploy step and holds no Railway credentials.
- **Build:** `railway.json` (Nixpacks, `npm run build`) + `nixpacks.toml`
  (`npm ci --include=dev`, because the service sets `NODE_ENV=production`).
- **Pre-deploy / start** (`railway.json`, since Phase 15E.4e.0): `npx prisma migrate deploy` runs as the
  pre-deploy command, then `npm run start:prod`; health check `GET /categories`. Migrations are not
  reversed by a rollback, so keep them backward-compatible.

> **Current status (2026-10-07):** API production releases are **blocked** — the Railway plan/account
> access has expired (owner-reported). The last deployment on record is `2ea83b6` (2026-10-04); nothing
> merged after it is live. Do not deploy or change Railway; the owner restores access. Details:
> `docs/my-andijan/CURRENT_STATE.md` in the `myandijan-frontend` repository.

Release, verification and rollback runbook: `docs/my-andijan/ENVIRONMENT.md`
("Deployment pipeline") in the `myandijan-frontend` repository.

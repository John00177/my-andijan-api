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
- **Start:** `npx prisma migrate deploy && npm run start:prod` — migrations run on every boot
  and are not reversed by a rollback, so keep them backward-compatible.

Release, verification and rollback runbook: `docs/my-andijan/ENVIRONMENT.md`
("Deployment pipeline") in the `myandijan-frontend` repository.

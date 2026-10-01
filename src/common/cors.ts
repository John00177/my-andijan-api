import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

// Browser origins allowed to call this API (Phase 15B — was `enableCors()`,
// i.e. any origin). Always includes the production site, so a stale or
// missing FRONTEND_URL can never take the live frontend down; FRONTEND_URL
// (already set on Railway) and the optional CORS_ORIGINS (comma-separated)
// add to it. Outside production, local dev servers are allowed too.
//
// CORS is a browser control, not authentication: requests without an Origin
// header (curl, server-to-server, native apps) are unaffected, and every
// route still enforces its own JWT/ownership/role checks. Auth is a Bearer
// header, not a cookie, so credentials stay disabled.
export const PRODUCTION_ORIGINS = ['https://myandijan.uz', 'https://www.myandijan.uz'] as const;
export const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173'] as const;

function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin; // scheme://host[:port], no path or trailing slash
  } catch {
    return null;
  }
}

export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const origins = new Set<string>(PRODUCTION_ORIGINS);
  for (const raw of [env.FRONTEND_URL, env.CORS_ORIGINS]) {
    for (const part of (raw ?? '').split(',')) {
      const origin = normalizeOrigin(part);
      if (origin) origins.add(origin);
    }
  }
  if (env.NODE_ENV !== 'production') {
    for (const origin of DEV_ORIGINS) origins.add(origin);
  }
  return origins;
}

export function buildCorsOptions(env: NodeJS.ProcessEnv = process.env): CorsOptions {
  const allowed = allowedOrigins(env);
  return {
    // A disallowed origin gets no Access-Control-Allow-Origin header (the
    // browser then blocks the response); it is not turned into a 500.
    origin: (origin, callback) => callback(null, !origin || allowed.has(origin)),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'Accept-Language'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    credentials: false,
    maxAge: 600,
  };
}

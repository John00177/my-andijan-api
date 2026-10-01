import { allowedOrigins, buildCorsOptions } from './cors';

// Phase 15B: CORS went from "any origin" to an allowlist.
describe('CORS allowlist', () => {
  const prod = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;

  function decide(env: NodeJS.ProcessEnv, origin: string | undefined): boolean {
    const options = buildCorsOptions(env);
    let allowed = false;
    (options.origin as (o: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void)(
      origin,
      (_err, allow) => (allowed = Boolean(allow)),
    );
    return allowed;
  }

  it('always allows the production site, even with no FRONTEND_URL set', () => {
    expect(decide(prod, 'https://myandijan.uz')).toBe(true);
    expect(decide(prod, 'https://www.myandijan.uz')).toBe(true);
  });

  it('rejects unrelated and look-alike origins in production', () => {
    expect(decide(prod, 'https://evil.example')).toBe(false);
    expect(decide(prod, 'https://myandijan.uz.evil.example')).toBe(false);
    expect(decide(prod, 'http://myandijan.uz')).toBe(false);
    expect(decide(prod, 'http://localhost:5173')).toBe(false);
  });

  it('adds FRONTEND_URL and CORS_ORIGINS, normalized to bare origins', () => {
    const env = {
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://myandijan-frontend.vercel.app/',
      CORS_ORIGINS: ' https://admin.myandijan.uz/path , not a url ,ftp://x.uz',
    } as NodeJS.ProcessEnv;
    const origins = allowedOrigins(env);

    expect(origins.has('https://myandijan-frontend.vercel.app')).toBe(true);
    expect(origins.has('https://admin.myandijan.uz')).toBe(true);
    expect([...origins].some((o) => o.startsWith('ftp:'))).toBe(false);
    expect(decide(env, 'https://myandijan-frontend.vercel.app')).toBe(true);
  });

  it('allows local dev servers outside production only', () => {
    const dev = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
    expect(decide(dev, 'http://localhost:5173')).toBe(true);
    expect(decide({} as NodeJS.ProcessEnv, 'http://127.0.0.1:5173')).toBe(true);
    expect(decide(prod, 'http://localhost:5173')).toBe(false);
  });

  it('leaves requests without an Origin header alone (curl, server-to-server, native apps)', () => {
    expect(decide(prod, undefined)).toBe(true);
  });

  it('keeps credentials off (Bearer auth) and allows only the headers the frontend sends', () => {
    const options = buildCorsOptions(prod);
    expect(options.credentials).toBe(false);
    expect(options.allowedHeaders).toEqual(expect.arrayContaining(['Authorization', 'Content-Type', 'Accept']));
  });
});

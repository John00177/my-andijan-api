import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { AddressInfo } from 'node:net';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AUTH_THROTTLER_OPTIONS } from './auth-throttle';

// Phase 15B: real HTTP through the real AuthController + ThrottlerGuard with
// the production limits; only AuthService is stubbed.
describe('Auth rate limiting (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  const authService = {
    login: jest.fn().mockResolvedValue({ ok: true }),
    register: jest.fn().mockResolvedValue({ ok: true }),
    refresh: jest.fn().mockResolvedValue({ ok: true }),
    requestOtp: jest.fn().mockResolvedValue({ ok: true }),
    verifyOtp: jest.fn().mockResolvedValue({ ok: true }),
    forgotPassword: jest.fn().mockResolvedValue({ ok: true }),
    verifyResetCode: jest.fn().mockResolvedValue({ ok: true }),
    resetPassword: jest.fn().mockResolvedValue({ ok: true }),
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(AUTH_THROTTLER_OPTIONS)],
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  function post(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('locks password guessing against one phone after 10 tries in 15 minutes, without locking other phones', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post('/auth/login', { phone: '+998901234567', password: `guess-${i}` })).status).toBe(200);
    }
    expect((await post('/auth/login', { phone: '+998901234567', password: 'guess-10' })).status).toBe(429);
    expect((await post('/auth/login', { phone: '+998907654321', password: 'mine' })).status).toBe(200);
  });

  it('caps SMS-code requests per phone at 5 per 15 minutes', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post('/auth/otp/request', { phone: '+998901234567' })).status).toBe(200);
    }
    expect((await post('/auth/otp/request', { phone: '+998901234567' })).status).toBe(429);
  });

  it('caps reset-code verification guesses per phone', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post('/auth/verify-reset-code', { phone: '+998901234567', code: `00000${i}` })).status).toBe(200);
    }
    expect((await post('/auth/verify-reset-code', { phone: '+998901234567', code: '999999' })).status).toBe(429);
  });

  it('caps one address across many phones, and forged proxy headers do not open a new bucket', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post('/auth/register', { phone: `+99890000000${i}` })).status).toBe(201);
    }
    const forged = await post(
      '/auth/register',
      { phone: '+998909999999' },
      { 'X-Forwarded-For': '198.51.100.7', 'X-Real-IP': '198.51.100.8' },
    );
    expect(forged.status).toBe(429);
  });

  it('does not apply the per-phone bucket to token refresh', async () => {
    for (let i = 0; i < 15; i++) {
      expect((await post('/auth/refresh', { refreshToken: `t-${i}` })).status).toBe(200);
    }
  });
});

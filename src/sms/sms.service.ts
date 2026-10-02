import { Injectable, Logger } from '@nestjs/common';

const ESKIZ_BASE = process.env.ESKIZ_BASE_URL ?? 'https://notify.eskiz.uz/api';
/** Eskiz tokens last 30 days; refresh well before that rather than on failure. */
const TOKEN_TTL_MS = 25 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Eskiz.uz SMS gateway.
 *
 * Eskiz does not issue a static API key: you exchange an email/password for a
 * bearer token that expires, so the token is minted on first use and cached in
 * memory. A single process holding one token is fine here — the token is
 * per-account, not per-instance, and re-minting on a cold start costs one
 * extra request.
 *
 * Messages carry authentication codes, so NOTHING here ever logs a message
 * body or a phone number (Phase 15E.2) — not when unconfigured, not on a
 * provider error. Without credentials nothing is sent and `send` returns
 * false; callers check `isConfigured` first and fail closed rather than
 * pretend a code went out. Tests and local development stub this service.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private token: string | null = null;
  private tokenFetchedAt = 0;
  /** In-flight login, so N concurrent sends trigger one login, not N. */
  private loginInFlight: Promise<string | null> | null = null;

  get isConfigured(): boolean {
    return !!(process.env.ESKIZ_EMAIL && process.env.ESKIZ_PASSWORD);
  }

  /** True only when the provider accepted the message. Never throws, never logs the content. */
  async send(phone: string, message: string): Promise<boolean> {
    if (!this.isConfigured) {
      this.logger.warn('SMS provider is not configured; message not sent');
      return false;
    }

    const token = await this.getToken();
    if (!token) {
      this.logger.error('Eskiz login failed; SMS not sent');
      return false;
    }

    try {
      const form = new FormData();
      // Eskiz expects the national number without the + prefix.
      form.append('mobile_phone', phone.replace(/\D/g, ''));
      form.append('message', message);
      if (process.env.ESKIZ_FROM) form.append('from', process.env.ESKIZ_FROM);

      const res = await fetch(`${ESKIZ_BASE}/message/sms/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        // A 401 means the cached token died early; drop it so the next send
        // re-logs in rather than repeating a doomed request. The response
        // body is not logged: a provider may echo the message back.
        if (res.status === 401) this.token = null;
        this.logger.error(`Eskiz send failed (${res.status})`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Eskiz send threw: ${err instanceof Error ? err.name : 'unknown error'}`);
      return false;
    }
  }

  private async getToken(): Promise<string | null> {
    if (this.token && Date.now() - this.tokenFetchedAt < TOKEN_TTL_MS) {
      return this.token;
    }
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = this.login().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async login(): Promise<string | null> {
    try {
      const form = new FormData();
      form.append('email', process.env.ESKIZ_EMAIL as string);
      form.append('password', process.env.ESKIZ_PASSWORD as string);

      const res = await fetch(`${ESKIZ_BASE}/auth/login`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        this.logger.error(`Eskiz login failed (${res.status})`);
        return null;
      }

      const body = (await res.json()) as { data?: { token?: string } };
      const token = body?.data?.token ?? null;
      if (token) {
        this.token = token;
        this.tokenFetchedAt = Date.now();
      }
      return token;
    } catch (err) {
      this.logger.error(`Eskiz login threw: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}

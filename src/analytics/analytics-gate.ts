import { Inject, Injectable, Optional } from '@nestjs/common';
import { getRequestContext } from '../common/request-context/request-context';

// Phase 16G: write hygiene for the anonymous POST /analytics/* collectors.
//
// They feed owner analytics, the command centre and the health score's
// visibility, and had neither de-duplication nor any cap: a page refresh, a
// double tap or a script counted as many events as it sent. This gate decides,
// per request, whether an event is RECORDED; the endpoint answers
// { success: true } either way — it is fire-and-forget telemetry, so a dropped
// event is invisible to an honest client and gives a scraper nothing to probe.
//
// A client is its address plus user-agent: several people behind one carrier
// CGNAT address (common in Uzbekistan — see auth-throttle.ts) still differ by
// device, so they are not merged into one visitor. The per-address budget is
// the abuse bound, and is generous for the same CGNAT reason.
//
// Deliberately not @nestjs/throttler: its module is global, and registering a
// second configuration next to the auth limits would change those (Phase 16
// discovery: "don't reuse auth's"). Like the auth throttler, state is
// in-process (correct for Railway's single replica, reset by a redeploy) and
// is never persisted — the raw address lives only in this memory, the same as
// for the auth limits, and never reaches a table.

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

export interface AnalyticsGateLimits {
  /** One view per client per business in this window (a refresh is not a new visit). */
  viewWindowMs: number;
  /** The same click twice in this window is one click (a double tap). */
  clickWindowMs: number;
  /** The same search (query + filters) again in this window is one search (re-renders, back/forward). */
  searchWindowMs: number;
  /** Events recorded per client ADDRESS per budget window; beyond it, events are dropped. */
  addressBudget: number;
  addressBudgetWindowMs: number;
  /** Memory bound for each of the two maps. */
  maxEntries: number;
}

export const ANALYTICS_GATE_LIMITS: AnalyticsGateLimits = {
  viewWindowMs: 30 * MINUTE,
  clickWindowMs: 10 * SECOND,
  searchWindowMs: MINUTE,
  addressBudget: 300,
  addressBudgetWindowMs: 10 * MINUTE,
  maxEntries: 50_000,
};

/** Injection token for overriding the limits (tests). */
export const ANALYTICS_GATE_LIMITS_TOKEN = 'ANALYTICS_GATE_LIMITS';

export type AnalyticsEventKind = 'view' | 'click' | 'search';

@Injectable()
export class AnalyticsGate {
  // key → expiry (epoch ms). Insertion order doubles as age order for eviction.
  private readonly seen = new Map<string, number>();
  private readonly budgets = new Map<string, { used: number; resetAt: number }>();

  constructor(
    @Optional() @Inject(ANALYTICS_GATE_LIMITS_TOKEN) private readonly limits: AnalyticsGateLimits = ANALYTICS_GATE_LIMITS,
  ) {}

  /**
   * True when this event should be recorded for the current request's client.
   * `event` identifies WHAT happened (e.g. the business id and action); the
   * client is taken from the request context. Outside an HTTP request (scripts,
   * tests) there is no client to key on, so everything is admitted.
   */
  admit(kind: AnalyticsEventKind, event: string): boolean {
    const context = getRequestContext();
    const address = context?.ipAddress;
    if (!address) return true;

    const now = Date.now();
    const key = `${address}|${context.userAgent ?? ''}|${kind}:${event}`;

    // A duplicate is dropped without spending budget.
    const expiresAt = this.seen.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;

    let budget = this.budgets.get(address);
    if (!budget || budget.resetAt <= now) {
      budget = { used: 0, resetAt: now + this.limits.addressBudgetWindowMs };
      remember(this.budgets, address, budget, this.limits.maxEntries, (b) => b.resetAt <= now);
    }
    if (budget.used >= this.limits.addressBudget) return false;
    budget.used += 1;

    remember(this.seen, key, now + this.windowFor(kind), this.limits.maxEntries, (at) => at <= now);
    return true;
  }

  private windowFor(kind: AnalyticsEventKind): number {
    if (kind === 'view') return this.limits.viewWindowMs;
    if (kind === 'click') return this.limits.clickWindowMs;
    return this.limits.searchWindowMs;
  }
}

/**
 * Sets key → value, re-inserting so the map stays in age order, and keeps the
 * map at most `max` entries: expired entries go first, then the oldest.
 */
function remember<V>(map: Map<string, V>, key: string, value: V, max: number, expired: (value: V) => boolean): void {
  map.delete(key);
  if (map.size >= max) {
    for (const [k, v] of map) if (expired(v)) map.delete(k);
    for (const k of map.keys()) {
      if (map.size < max) break;
      map.delete(k);
    }
  }
  map.set(key, value);
}

import { runWithRequestContext } from '../common/request-context/request-context';
import { ANALYTICS_GATE_LIMITS, AnalyticsGate, AnalyticsGateLimits } from './analytics-gate';

// Phase 16G: which anonymous analytics events get RECORDED.

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14) Mobile';
const LAPTOP_UA = 'Mozilla/5.0 (Windows NT 10.0) Desktop';

function as<T>(ipAddress: string | null, userAgent: string | null, fn: () => T): T {
  return runWithRequestContext({ requestId: 'r', ipAddress, userAgent }, fn);
}

describe('AnalyticsGate (Phase 16G)', () => {
  const T0 = new Date('2026-10-07T10:00:00Z').getTime();
  let gate: AnalyticsGate;

  const make = (limits: Partial<AnalyticsGateLimits> = {}) => new AnalyticsGate({ ...ANALYTICS_GATE_LIMITS, ...limits });
  const at = (ms: number) => jest.setSystemTime(T0 + ms);
  const admit = (
    kind: 'view' | 'click' | 'search',
    event: string,
    ip: string | null = '203.0.113.7',
    ua: string | null = PHONE_UA,
  ) => as(ip, ua, () => gate.admit(kind, event));

  beforeEach(() => {
    jest.useFakeTimers();
    at(0);
    gate = make();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('counts a refresh of the same business page as one view for 30 minutes, then again', () => {
    expect(admit('view', '5')).toBe(true);
    at(60_000);
    expect(admit('view', '5')).toBe(false);
    at(30 * 60_000 - 1);
    expect(admit('view', '5')).toBe(false);
    at(30 * 60_000);
    expect(admit('view', '5')).toBe(true);
  });

  it('treats a double-tapped click as one, but a click 10 s later as a new one', () => {
    expect(admit('click', '5:CALL')).toBe(true);
    at(500);
    expect(admit('click', '5:CALL')).toBe(false);
    at(10_000);
    expect(admit('click', '5:CALL')).toBe(true);
  });

  it('de-duplicates a repeated search for a minute', () => {
    expect(admit('search', ':::kafe')).toBe(true);
    at(59_999);
    expect(admit('search', ':::kafe')).toBe(false);
    at(60_000);
    expect(admit('search', ':::kafe')).toBe(true);
  });

  it('keeps businesses, actions and event kinds apart', () => {
    expect(admit('view', '5')).toBe(true);
    expect(admit('view', '6')).toBe(true);
    expect(admit('click', '5:CALL')).toBe(true);
    expect(admit('click', '5:DIRECTION')).toBe(true);
    expect(admit('search', '5')).toBe(true);
  });

  it('does not merge two devices behind one carrier (CGNAT) address into one visitor', () => {
    expect(admit('view', '5', '198.51.100.1', PHONE_UA)).toBe(true);
    expect(admit('view', '5', '198.51.100.1', LAPTOP_UA)).toBe(true);
    expect(admit('view', '5', '198.51.100.2', PHONE_UA)).toBe(true);
    expect(admit('view', '5', '198.51.100.1', null)).toBe(true);
  });

  it('caps what one address can record per window — however it varies the user-agent — and resets after it', () => {
    gate = make({ addressBudget: 3, addressBudgetWindowMs: 60_000 });
    expect([1, 2, 3, 4].map((n) => admit('view', String(n), '192.0.2.9', `bot/${n}`))).toEqual([true, true, true, false]);
    expect(admit('view', '99', '192.0.2.10')).toBe(true); // another address has its own budget
    at(60_000);
    expect(admit('view', '4', '192.0.2.9', 'bot/4')).toBe(true);
  });

  it('does not spend budget on duplicates it drops', () => {
    gate = make({ addressBudget: 2 });
    expect(admit('view', '5')).toBe(true);
    expect(admit('view', '5')).toBe(false);
    expect(admit('view', '5')).toBe(false);
    expect(admit('view', '6')).toBe(true);
  });

  it('admits everything outside an HTTP request (scripts, tests) or when no address is known', () => {
    expect(gate.admit('view', '5')).toBe(true);
    expect(gate.admit('view', '5')).toBe(true);
    expect(admit('view', '5', null)).toBe(true);
    expect(admit('view', '5', null)).toBe(true);
  });

  it('stays within its memory bound, evicting expired entries first, then the oldest', () => {
    gate = make({ maxEntries: 3, addressBudget: 1_000 });
    for (const n of [1, 2, 3, 4, 5]) expect(admit('view', String(n))).toBe(true);
    const state = gate as unknown as { seen: Map<string, number>; budgets: Map<string, unknown> };
    expect(state.seen.size).toBe(3);
    // 1 and 2 were evicted (oldest), so they count again; 5 is still remembered.
    expect(admit('view', '5')).toBe(false);
    expect(admit('view', '1')).toBe(true);

    for (let n = 0; n < 10; n++) admit('view', 'x', `192.0.2.${n}`);
    expect(state.budgets.size).toBeLessThanOrEqual(3);

    // Once entries expire they are the first to go.
    at(31 * 60_000);
    admit('view', 'fresh');
    expect(state.seen.size).toBe(1);
  });
});

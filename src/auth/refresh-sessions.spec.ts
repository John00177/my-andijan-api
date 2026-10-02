import { isWithinRefreshGraceWindow, MAX_CLOCK_SKEW_MS, REFRESH_GRACE_WINDOW_MS } from './refresh-sessions';

// The grace window (Phase 15E.4b): bounded at REFRESH_GRACE_WINDOW_MS into the
// past and at MAX_CLOCK_SKEW_MS into the future, and only while the successor
// is unused. Logout relies on it; 15E.4c will too.
describe('isWithinRefreshGraceWindow', () => {
  const now = new Date('2026-10-02T12:00:00.000Z');
  const rotated = (offsetMs: number) => ({ rotatedAt: new Date(now.getTime() + offsetMs) });
  const unused = { rotatedAt: null };

  it('the bounds are 10 s of age and 5 s of clock skew', () => {
    expect(REFRESH_GRACE_WINDOW_MS).toBe(10_000);
    expect(MAX_CLOCK_SKEW_MS).toBe(5_000);
  });

  it('rotation 10 seconds or less in the past → true', () => {
    expect(isWithinRefreshGraceWindow(rotated(0), unused, now)).toBe(true);
    expect(isWithinRefreshGraceWindow(rotated(-1), unused, now)).toBe(true);
    expect(isWithinRefreshGraceWindow(rotated(-5_000), unused, now)).toBe(true);
    expect(isWithinRefreshGraceWindow(rotated(-REFRESH_GRACE_WINDOW_MS), unused, now)).toBe(true);
  });

  it('rotation beyond 10 seconds in the past → false', () => {
    expect(isWithinRefreshGraceWindow(rotated(-REFRESH_GRACE_WINDOW_MS - 1), unused, now)).toBe(false);
    expect(isWithinRefreshGraceWindow(rotated(-60_000), unused, now)).toBe(false);
  });

  it('rotation slightly in the future, within the allowed clock skew → true', () => {
    expect(isWithinRefreshGraceWindow(rotated(1), unused, now)).toBe(true);
    expect(isWithinRefreshGraceWindow(rotated(2_000), unused, now)).toBe(true);
    expect(isWithinRefreshGraceWindow(rotated(MAX_CLOCK_SKEW_MS), unused, now)).toBe(true);
  });

  it('rotation farther in the future than the allowed skew → false', () => {
    expect(isWithinRefreshGraceWindow(rotated(MAX_CLOCK_SKEW_MS + 1), unused, now)).toBe(false);
    expect(isWithinRefreshGraceWindow(rotated(60 * 60 * 1000), unused, now)).toBe(false);
    expect(isWithinRefreshGraceWindow(rotated(365 * 24 * 60 * 60 * 1000), unused, now)).toBe(false);
  });

  it('successor already used → false, even inside the window', () => {
    const used = { rotatedAt: new Date(now.getTime() - 1) };
    for (const offset of [0, -1_000, -REFRESH_GRACE_WINDOW_MS, 1_000, MAX_CLOCK_SKEW_MS]) {
      expect(isWithinRefreshGraceWindow(rotated(offset), used, now)).toBe(false);
    }
  });

  it('a token that was never rotated → false', () => {
    expect(isWithinRefreshGraceWindow({ rotatedAt: null }, unused, now)).toBe(false);
  });
});

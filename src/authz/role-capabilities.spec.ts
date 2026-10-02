import { UserRole } from '@prisma/client';
import { CAPABILITIES, Capability, ROLE_CAPABILITIES, capabilitiesFor, hasCapability } from './capabilities';

// Phase 15D (D-75): THE role → capability table, pinned line by line. These
// expectations are written out by hand on purpose — changing what a role may
// do must be a deliberate edit in two places, reviewed together.
const EXPECTED: Record<UserRole, Capability[]> = {
  CUSTOMER: ['review.write', 'review.report', 'business.claim'],
  BUSINESS_OWNER: ['review.write', 'review.report', 'business.claim', 'business.create', 'business.manage_own'],
  SUPPORT: ['review.write', 'review.report'],
  MODERATOR: ['review.write', 'review.report', 'business.review', 'review.moderate', 'report.resolve'],
  ADMIN: [
    'review.write',
    'review.report',
    'business.review',
    'review.moderate',
    'report.resolve',
    'business.operate',
    'business.edit_any',
    'claim.review',
    'event.review',
    'taxonomy.manage',
    'user.pii.read',
    'user.status.manage',
    'audit.read',
    'analytics.platform',
  ],
  SUPER_ADMIN: [
    'review.write',
    'review.report',
    'business.review',
    'review.moderate',
    'report.resolve',
    'business.operate',
    'business.edit_any',
    'claim.review',
    'event.review',
    'taxonomy.manage',
    'user.pii.read',
    'user.status.manage',
    'audit.read',
    'analytics.platform',
    'business.hide',
    'business.delete',
    'analytics.users',
  ],
};

const OWNER_CAPS: Capability[] = ['business.create', 'business.manage_own', 'business.claim'];
const SUPER_ONLY: Capability[] = ['business.hide', 'business.delete', 'analytics.users'];

describe('Role → capability table', () => {
  it.each(Object.values(UserRole))('%s holds exactly its listed capabilities', (role) => {
    expect([...ROLE_CAPABILITIES[role]].sort()).toEqual([...EXPECTED[role]].sort());
  });

  it('defines every role and only known capabilities', () => {
    expect(Object.keys(ROLE_CAPABILITIES).sort()).toEqual(Object.values(UserRole).sort());
    for (const set of Object.values(ROLE_CAPABILITIES)) for (const cap of set) expect(CAPABILITIES).toContain(cap);
  });

  it('every capability is held by at least one role (no dead capability)', () => {
    for (const cap of CAPABILITIES) {
      expect(Object.values(UserRole).some((role) => hasCapability(role, cap))).toBe(true);
    }
  });

  it('SUPPORT ≠ BUSINESS_OWNER: SUPPORT holds no business-owner capability', () => {
    for (const cap of OWNER_CAPS) expect(hasCapability(UserRole.SUPPORT, cap)).toBe(false);
  });

  it('SUPPORT holds no staff capability at all (support desk is a later phase)', () => {
    expect([...ROLE_CAPABILITIES.SUPPORT].sort()).toEqual(['review.report', 'review.write']);
  });

  // Phase 15D.2: ownership authority and platform authority are separate.
  it('BUSINESS_OWNER holds every business-owner capability', () => {
    for (const cap of OWNER_CAPS) expect(hasCapability(UserRole.BUSINESS_OWNER, cap)).toBe(true);
  });

  it.each([UserRole.ADMIN, UserRole.SUPER_ADMIN])(
    '%s holds NO business-owner capability but keeps platform business administration (business.edit_any)',
    (role) => {
      for (const cap of OWNER_CAPS) expect(hasCapability(role, cap)).toBe(false);
      expect(capabilitiesFor(role)).not.toEqual(expect.arrayContaining(['business.manage_own']));
      expect(hasCapability(role, 'business.edit_any')).toBe(true);
      expect(hasCapability(role, 'business.operate')).toBe(true);
    },
  );

  it('no platform staff role holds any business-owner capability', () => {
    for (const role of [UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN]) {
      for (const cap of OWNER_CAPS) expect({ role, cap, held: hasCapability(role, cap) }).toEqual({ role, cap, held: false });
    }
  });

  it('BUSINESS_OWNER holds no platform capability', () => {
    expect([...ROLE_CAPABILITIES.BUSINESS_OWNER].sort()).toEqual([...EXPECTED.BUSINESS_OWNER].sort());
    expect(hasCapability(UserRole.BUSINESS_OWNER, 'business.edit_any')).toBe(false);
  });

  it('MODERATOR ≠ ADMIN: MODERATOR holds moderation only', () => {
    const adminOnly = EXPECTED.ADMIN.filter((c) => !EXPECTED.MODERATOR.includes(c));
    for (const cap of adminOnly) expect(hasCapability(UserRole.MODERATOR, cap)).toBe(false);
    expect(hasCapability(UserRole.MODERATOR, 'business.manage_own')).toBe(false);
    expect(hasCapability(UserRole.MODERATOR, 'user.pii.read')).toBe(false);
  });

  it('ADMIN ≠ SUPER_ADMIN: hide, delete and user analytics are SUPER_ADMIN only', () => {
    for (const cap of SUPER_ONLY) {
      expect(hasCapability(UserRole.ADMIN, cap)).toBe(false);
      expect(hasCapability(UserRole.SUPER_ADMIN, cap)).toBe(true);
    }
  });

  it('SUPER_ADMIN ≠ PLATFORM_OWNER: no governance capability exists for any role', () => {
    expect(CAPABILITIES.filter((c) => /governance|owner\.transfer|role\.|appoint|platform_owner/i.test(c))).toEqual([]);
    expect(Object.values(UserRole)).not.toContain('PLATFORM_OWNER');
  });

  it('an unknown or missing role holds nothing (fail closed)', () => {
    expect(hasCapability(undefined, 'review.write')).toBe(false);
    expect(hasCapability(null, 'review.write')).toBe(false);
    expect(hasCapability('PLATFORM_OWNER' as UserRole, 'business.hide')).toBe(false);
  });

  it('capabilitiesFor returns the role set in canonical order', () => {
    expect(capabilitiesFor(UserRole.MODERATOR)).toEqual([
      'review.write',
      'review.report',
      'business.review',
      'review.moderate',
      'report.resolve',
    ]);
  });
});

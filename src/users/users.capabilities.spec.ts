import { UserRole } from '@prisma/client';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { capabilitiesFor } from '../authz/capabilities';

// GET /users/me exposes the caller's role AND capabilities (Phase 15D, D-75)
// so the frontend renders from capabilities instead of hard-coded role
// checks. A display hint only: every route enforces its own rule.
describe('GET /users/me capabilities', () => {
  it.each(Object.values(UserRole))('returns the %s capability set alongside the role', async (role) => {
    const prisma = { user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 1, phone: '+998900000001', role }) } };
    const me = await new UsersService(prisma as unknown as PrismaService).getMe(1);
    expect(me.role).toBe(role);
    expect(me.capabilities).toEqual(capabilitiesFor(role));
  });

  it('never exposes a governance capability, even to SUPER_ADMIN', async () => {
    const prisma = {
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 1, phone: '+998900000001', role: UserRole.SUPER_ADMIN }) },
    };
    const me = await new UsersService(prisma as unknown as PrismaService).getMe(1);
    expect(me.capabilities.filter((c) => /governance|owner/i.test(c))).toEqual([]);
  });

  // Phase 15D.2: the owner area is driven by these capabilities, so staff must
  // not receive them — and a BUSINESS_OWNER must.
  const OWNER_CAPS = ['business.claim', 'business.create', 'business.manage_own'];
  const meFor = (role: UserRole) =>
    new UsersService({
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 1, phone: '+998900000001', role }) },
    } as unknown as PrismaService).getMe(1);

  it('BUSINESS_OWNER receives every owner capability', async () => {
    expect((await meFor(UserRole.BUSINESS_OWNER)).capabilities).toEqual(expect.arrayContaining(OWNER_CAPS));
  });

  it.each([UserRole.ADMIN, UserRole.SUPER_ADMIN])('%s receives no owner capability but keeps business.edit_any', async (role) => {
    const { capabilities } = await meFor(role);
    expect(capabilities.filter((c) => OWNER_CAPS.includes(c))).toEqual([]);
    expect(capabilities).toContain('business.edit_any');
  });
});

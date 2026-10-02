import { UserRole } from '@prisma/client';
import { APP_GUARD } from '@nestjs/core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from '../app.module';
import { AuthzGuard } from './authz.guard';
import { decide } from './decide';
import { CAPABILITIES } from './capabilities';
import { describeRule, routeInventory, routeSnapshot } from './route-inventory';

// PERMANENT SECURITY CONTROL (Phase 15D, D-75).
//
// 1. Every HTTP route must declare exactly one authorization rule. A new
//    endpoint without @Public / @Authenticated / @RequireCapability fails
//    here (and AuthzGuard refuses it at runtime anyway).
// 2. The committed snapshot (route-authorization.snapshot.json) must equal
//    what the code declares. Any change to any route's rule — or any new or
//    removed route — fails CI until the snapshot is regenerated on purpose:
//      UPDATE_ROUTE_SNAPSHOT=1 npx jest src/authz/route-authorization.spec.ts
//    and the diff is reviewed in the commit.
// 3. Every route's decision for every role is checked against a hand-written
//    expectation that does NOT read the role→capability table.
const SNAPSHOT_FILE = join(__dirname, 'route-authorization.snapshot.json');
const ROLES = Object.values(UserRole);

// Independent restatement of who holds each capability. Must agree with
// ROLE_CAPABILITIES (role-capabilities.spec.ts proves the table itself).
const HOLDERS: Record<string, UserRole[]> = {
  'review.write': ROLES,
  'review.report': ROLES,
  'business.claim': [UserRole.CUSTOMER, UserRole.BUSINESS_OWNER, UserRole.ADMIN, UserRole.SUPER_ADMIN],
  'business.create': [UserRole.BUSINESS_OWNER, UserRole.ADMIN, UserRole.SUPER_ADMIN],
  'business.manage_own': [UserRole.BUSINESS_OWNER, UserRole.ADMIN, UserRole.SUPER_ADMIN],
  'business.review': [UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN],
  'review.moderate': [UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN],
  'report.resolve': [UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN],
  'business.operate': [UserRole.ADMIN, UserRole.SUPER_ADMIN],
  'business.edit_any': [UserRole.ADMIN, UserRole.SUPER_ADMIN],
  'claim.review': [UserRole.ADMIN, UserRole.SUPER_ADMIN],
  'event.review': [UserRole.ADMIN, UserRole.SUPER_ADMIN],
  'taxonomy.manage': [UserRole.ADMIN, UserRole.SUPER_ADMIN],
  'user.pii.read': [UserRole.ADMIN, UserRole.SUPER_ADMIN],
  'user.status.manage': [UserRole.ADMIN, UserRole.SUPER_ADMIN],
  'audit.read': [UserRole.ADMIN, UserRole.SUPER_ADMIN],
  'analytics.platform': [UserRole.ADMIN, UserRole.SUPER_ADMIN],
  'business.hide': [UserRole.SUPER_ADMIN],
  'business.delete': [UserRole.SUPER_ADMIN],
  'analytics.users': [UserRole.SUPER_ADMIN],
};

describe('Route authorization inventory', () => {
  const inventory = routeInventory();

  if (process.env.UPDATE_ROUTE_SNAPSHOT === '1') {
    writeFileSync(SNAPSHOT_FILE, JSON.stringify(routeSnapshot(), null, 2) + '\n');
  }

  it('finds the whole API surface', () => {
    expect(inventory.length).toBeGreaterThanOrEqual(127);
    expect(new Set(inventory.map((e) => e.route)).size).toBe(inventory.length);
  });

  it('every route declares an authorization rule (no undeclared endpoint)', () => {
    const undeclared = inventory.filter((e) => !e.rule).map((e) => `${e.route} (${e.controller}.${e.handler})`);
    expect(undeclared).toEqual([]);
  });

  it('no route uses the governance placeholder — PLATFORM_OWNER governance is not implemented', () => {
    expect(inventory.filter((e) => e.rule?.kind === 'governance')).toEqual([]);
  });

  it('every capability a route requires is a defined capability', () => {
    for (const { rule } of inventory) {
      if (rule?.kind === 'capability') {
        for (const capability of rule.capabilities) expect(CAPABILITIES).toContain(capability);
      }
    }
  });

  it('matches the committed route → rule snapshot (regenerate deliberately when a rule changes)', () => {
    expect(existsSync(SNAPSHOT_FILE)).toBe(true);
    const committed = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
    expect(routeSnapshot()).toEqual(committed);
  });

  it('AuthzGuard is registered globally (APP_GUARD), so the rules are actually enforced', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as Array<{ provide?: unknown; useClass?: unknown }>;
    expect(providers).toContainEqual({ provide: APP_GUARD, useClass: AuthzGuard });
  });

  describe('every route × every role', () => {
    for (const { route, rule } of inventory) {
      it(`${route} [${describeRule(rule)}]`, () => {
        for (const role of ROLES) {
          const got = decide(rule, role);
          let expected: string;
          if (rule?.kind === 'public' || rule?.kind === 'authenticated') expected = 'allow';
          else if (rule?.kind === 'capability')
            expected = rule.capabilities.every((c) => HOLDERS[c]?.includes(role)) ? 'allow' : 'forbidden';
          else expected = 'forbidden';
          expect({ role, decision: got }).toEqual({ role, decision: expected });
        }
        // Anonymous callers: only public routes are open.
        expect(decide(rule, null)).toBe(rule?.kind === 'public' ? 'allow' : 'unauthenticated');
      });
    }
  });
});

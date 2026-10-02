import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

// Phase 15D (D-75): the numeric role hierarchy is GONE and must not come
// back. Authorization is capability + ownership; a role is never compared
// to another role's "level". This scans every non-test source file.
const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path).replace(/\\/g, '/'),
  text: readFileSync(path, 'utf8')
    // comments may mention the history; only code counts
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, ''),
}));

function offenders(pattern: RegExp, allow: string[] = []): string[] {
  return files.filter((f) => pattern.test(f.text) && !allow.includes(f.path)).map((f) => f.path);
}

describe('No rank-based authorization', () => {
  it('the old hierarchy, RolesGuard and @Roles are deleted', () => {
    for (const file of ['common/constants/role-hierarchy.ts', 'common/guards/roles.guard.ts', 'common/decorators/roles.decorator.ts']) {
      expect(existsSync(join(SRC, file))).toBe(false);
    }
  });

  it('nothing references ROLE_HIERARCHY, RolesGuard or @Roles(', () => {
    expect(offenders(/ROLE_HIERARCHY|RolesGuard|@Roles\(|roles\.decorator|role-hierarchy/)).toEqual([]);
  });

  it('no role is compared by order/level (no <, >, <=, >= on a role or a rank table)', () => {
    expect(offenders(/\.role\s*(<=|>=|<|>)(?!=)|\b(rank|level)\s*\[\s*\w*\.?role\s*\]/i)).toEqual([]);
  });

  it('every `role ===` comparison is a known data transition, not an authorization check', () => {
    // Remaining role equalities in code: the CUSTOMER→BUSINESS_OWNER
    // auto-promotion on business/claim approval (a data transition), and the
    // explicit target table in user-status.policy.ts naming the ADMIN
    // emergency-freeze case. None compares levels.
    const hits = files.flatMap((f) =>
      [...f.text.matchAll(/\.role\s*(===|!==)\s*UserRole\.(\w+)/g)].map((m) => `${f.path}:${m[2]}`),
    );
    expect(hits.sort()).toEqual([
      'admin/admin.service.ts:CUSTOMER',
      'admin/admin.service.ts:CUSTOMER',
      'authz/user-status.policy.ts:ADMIN',
    ]);
  });

  it('JwtAuthGuard is used only by AuthzGuard (controllers declare rules, not guards)', () => {
    expect(offenders(/JwtAuthGuard/, ['authz/authz.guard.ts', 'common/guards/jwt-auth.guard.ts'])).toEqual([]);
  });

  it('no controller attaches its own auth guard — the global AuthzGuard is the only one', () => {
    const controllers = files.filter((f) => f.path.endsWith('.controller.ts'));
    const guarded = controllers
      .filter((f) => /@UseGuards\(/.test(f.text) && !/@UseGuards\(ThrottlerGuard\)/.test(f.text))
      .map((f) => f.path);
    expect(guarded).toEqual([]);
  });
});

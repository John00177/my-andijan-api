import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AdminController } from './admin.controller';
import { UserStatusChangeDto } from './dto/user.dto';
import { RegisterDto } from '../auth/dto/register.dto';
import { UpdateProfileDto as AuthProfileDto } from '../auth/dto/update-profile.dto';
import { UpdateProfileDto as UsersProfileDto } from '../users/dto/update-profile.dto';

// Phase 15B governance boundary. Until the PLATFORM_OWNER governance plane
// exists there is NO API that assigns ADMIN or SUPER_ADMIN, or that changes a
// staff account's role — so SUPER_ADMIN cannot appoint, promote or demote an
// ADMIN or another SUPER_ADMIN, and no operational role can mint itself into
// the future owner position. These tests pin that: they fail if a new code
// path starts writing users.role, or if any accepted request body starts
// carrying a role.
const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

// Drops every balanced `where: { ... }` block — a role in a WHERE filter (the
// suspension compare-and-set matches on it) reads the role, never writes it.
function withoutWhereClauses(call: string): string {
  let out = call;
  for (let start = out.indexOf('where:'); start !== -1; start = out.indexOf('where:')) {
    let i = out.indexOf('{', start);
    let depth = 0;
    for (; i < out.length; i++) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}' && --depth === 0) break;
    }
    out = out.slice(0, start) + out.slice(i + 1);
  }
  return out;
}

// The text of every `.user.create/update/updateMany/upsert(...)` call that
// WRITES `role`, as "file: call".
function roleWrites(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    const pattern = /\.user\.(create|update|updateMany|upsert)\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      let depth = 0;
      let end = match.index + match[0].length - 1;
      for (; end < text.length; end++) {
        if (text[end] === '(') depth++;
        else if (text[end] === ')' && --depth === 0) break;
      }
      const call = withoutWhereClauses(text.slice(match.index, end + 1));
      if (/\brole\s*:/.test(call)) found.push(`${relative(SRC, file).replace(/\\/g, '/')}: ${call.replace(/\s+/g, ' ')}`);
    }
  }
  return found;
}

describe('Role-write inventory — no API can grant or change a staff role', () => {
  const writes = roleWrites();

  it('writes users.role in exactly four places', () => {
    expect(writes).toHaveLength(4);
  });

  it('every role write assigns only CUSTOMER or BUSINESS_OWNER', () => {
    for (const write of writes) {
      const assigned = write.match(/role:\s*([^,}]+)/)?.[1].trim();
      expect([
        'UserRole.BUSINESS_OWNER', // business approval / claim approval auto-promotion
        'UserRole.CUSTOMER', // first OTP sign-in
        'dto.role ?? UserRole.CUSTOMER', // self-registration, DTO-whitelisted below
      ]).toContain(assigned);
    }
  });

  it('the BUSINESS_OWNER promotions only ever apply to a CUSTOMER', () => {
    const adminService = readFileSync(join(SRC, 'admin/admin.service.ts'), 'utf8');
    const promotions = adminService.match(/if \((owner|claimant)[^)]*\.role === UserRole\.CUSTOMER\)/g) ?? [];
    expect(promotions).toHaveLength(2);
  });

  it('AdminController exposes no role-management handler', () => {
    const handlers = Object.getOwnPropertyNames(AdminController.prototype).filter((n) => n !== 'constructor');
    expect(handlers.filter((name) => /role|appoint|promoteUser|demote|grant/i.test(name))).toEqual([]);
  });
});

describe('No request body can carry a role', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const validate = (metatype: new () => object, value: Record<string, unknown>) =>
    pipe.transform(value, { type: 'body', metatype });

  it.each([UserRole.SUPPORT, UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN])(
    'public registration rejects role=%s',
    async (role) => {
      await expect(
        validate(RegisterDto, { phone: '+998901234567', password: 'Passw0rd!', fullName: 'X', role }),
      ).rejects.toBeDefined();
    },
  );

  it('PATCH /users/me rejects a role field', async () => {
    await expect(validate(UsersProfileDto, { role: UserRole.SUPER_ADMIN })).rejects.toBeDefined();
  });

  it('PUT /auth/profile rejects a role field', async () => {
    await expect(validate(AuthProfileDto, { role: UserRole.ADMIN })).rejects.toBeDefined();
  });

  it('suspend/activate bodies reject a role field (status changes cannot smuggle a role change)', async () => {
    await expect(validate(UserStatusChangeDto, { reason: 'x', role: UserRole.ADMIN })).rejects.toBeDefined();
    await expect(validate(UserStatusChangeDto, { reason: 'Spam' })).resolves.toEqual({ reason: 'Spam' });
  });

  it('suspend/activate require a non-empty reason', async () => {
    await expect(validate(UserStatusChangeDto, {})).rejects.toBeDefined();
    await expect(validate(UserStatusChangeDto, { reason: '' })).rejects.toBeDefined();
  });
});

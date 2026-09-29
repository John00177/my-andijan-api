import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserRole } from '@prisma/client';
import { RegisterDto } from './register.dto';

const VALID = {
  phone: '+998901234567',
  password: 'strongpassword',
  fullName: 'Test User',
};

describe('RegisterDto', () => {
  it('accepts a minimal valid payload', async () => {
    const dto = plainToInstance(RegisterDto, { ...VALID });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects a password shorter than 8 characters', async () => {
    const dto = plainToInstance(RegisterDto, { ...VALID, password: 'short' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });

  it('rejects role=ADMIN at the DTO layer', async () => {
    const dto = plainToInstance(RegisterDto, { ...VALID, role: UserRole.ADMIN });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'role')).toBe(true);
  });

  it('accepts role=BUSINESS_OWNER', async () => {
    const dto = plainToInstance(RegisterDto, { ...VALID, role: UserRole.BUSINESS_OWNER });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects an invalid email when provided', async () => {
    const dto = plainToInstance(RegisterDto, { ...VALID, email: 'not-an-email' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'email')).toBe(true);
  });
});

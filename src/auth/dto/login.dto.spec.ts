import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from './login.dto';

describe('LoginDto', () => {
  it('accepts a valid Uzbek phone number and password', async () => {
    const dto = plainToInstance(LoginDto, { phone: '+998901234567', password: 'secret123' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it.each(['998901234567', '+99890123456', '+9989012345678', 'not-a-phone', ''])(
    'rejects an invalid phone %p',
    async (phone) => {
      const dto = plainToInstance(LoginDto, { phone, password: 'secret123' });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'phone')).toBe(true);
    },
  );

  it('rejects a non-string password', async () => {
    const dto = plainToInstance(LoginDto, { phone: '+998901234567', password: 12345 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });
});

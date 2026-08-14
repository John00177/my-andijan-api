import { Matches } from 'class-validator';

export class ForgotPasswordDto {
  @Matches(/^\+998\d{9}$/, {
    message: 'phone must be in the format +998XXXXXXXXX',
  })
  phone: string;
}

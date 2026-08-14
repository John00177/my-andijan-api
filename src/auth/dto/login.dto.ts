import { IsString, Matches } from 'class-validator';

export class LoginDto {
  @Matches(/^\+998\d{9}$/, {
    message: 'phone must be in the format +998XXXXXXXXX',
  })
  phone: string;

  @IsString()
  password: string;
}

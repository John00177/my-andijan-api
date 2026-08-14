import { IsString, Length, Matches } from 'class-validator';

export class VerifyResetCodeDto {
  @Matches(/^\+998\d{9}$/, {
    message: 'phone must be in the format +998XXXXXXXXX',
  })
  phone: string;

  @IsString()
  @Length(6, 6, { message: 'code must be 6 digits' })
  code: string;
}

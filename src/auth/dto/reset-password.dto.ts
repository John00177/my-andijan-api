import { IsString, Length, Matches, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @Matches(/^\+998\d{9}$/, {
    message: 'phone must be in the format +998XXXXXXXXX',
  })
  phone: string;

  @IsString()
  @Length(6, 6, { message: 'code must be 6 digits' })
  code: string;

  @IsString()
  @MinLength(8, { message: 'newPassword must be at least 8 characters' })
  newPassword: string;
}

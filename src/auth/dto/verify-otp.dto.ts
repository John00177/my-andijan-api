import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class VerifyOtpDto {
  @ApiProperty({ example: '+998901234567' })
  @Matches(/^\+998\d{9}$/, { message: 'phone must be in +998XXXXXXXXX format' })
  phone: string;

  @ApiProperty({ example: '123456' })
  @Matches(/^\d{6}$/, { message: 'otp must be 6 digits' })
  otp: string;
}

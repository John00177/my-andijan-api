import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { UserRole } from '@prisma/client';
import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, MinLength } from 'class-validator';

// Only CUSTOMER and BUSINESS_OWNER may self-register. ADMIN is intentionally
// excluded from the allowed values below — attempting to register with
// role=ADMIN fails validation before it ever reaches the service layer.
export class RegisterDto {
  @Matches(/^\+998\d{9}$/, {
    message: 'phone must be in the format +998XXXXXXXXX',
  })
  phone: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  password: string;

  @IsString()
  @MinLength(2)
  fullName: string;

  @ApiPropertyOptional({ enum: [UserRole.CUSTOMER, UserRole.BUSINESS_OWNER] })
  @IsOptional()
  @IsIn([UserRole.CUSTOMER, UserRole.BUSINESS_OWNER], {
    message: 'role must be CUSTOMER or BUSINESS_OWNER',
  })
  role?: UserRole;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  marketingConsent?: boolean = false;

  // Not required at signup — most users register before ever thinking about
  // a district. @Type coerces a numeric string (how HTML <select> values
  // arrive) as well as a real JSON number.
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  districtId?: number;
}

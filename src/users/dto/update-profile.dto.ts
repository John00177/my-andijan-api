import { Type } from 'class-transformer';
import { Gender } from '@prisma/client';
import { IsEmail, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(16)
  @Max(100)
  age?: number;

  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @IsOptional()
  @IsString()
  avatarId?: string;

  // Coerced from string, matching how every other numeric-id field on this
  // API is accepted from the client (see RegisterDto.districtId) — Prisma's
  // User.districtId is Int?, so a raw string here would fail at the DB layer.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  districtId?: number;
}

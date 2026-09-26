import { Type } from 'class-transformer';
import { BusinessStatus } from '@prisma/client';
import { IsDateString, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListBusinessesAdminQueryDto {
  @IsOptional()
  @IsIn(Object.values(BusinessStatus))
  status?: BusinessStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  district?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class RejectBusinessDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}

export class SuspendBusinessDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}

export class PromoteBusinessDto {
  @IsDateString()
  until: string;
}

// Core-field editing only — status transitions (approve/reject/suspend/hide)
// stay on their own dedicated endpoints, each with its own audit action and
// side effects (notifications, owner role promotion). Folding status into a
// generic PATCH would bypass all of that.
export class UpdateBusinessDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoryId?: number;
}

// Targets the business's primary branch (falling back to its oldest branch
// if none is flagged primary) — an admin editing "the business's contact
// info" has no reason to pick among branches the way an owner managing their
// own listing might.
export class UpdateBusinessBranchDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  districtId?: number;
}

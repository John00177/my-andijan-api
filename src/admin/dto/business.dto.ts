import { Type } from 'class-transformer';
import { BusinessStatus } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { BusinessHourInputDto } from '../../businesses/dto/update-business-hours.dto';

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

// Every staff edit of a business someone else owns carries a reason, stored
// as the audit row's note (Phase 15B, D-74).
export class StaffReasonDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}

// Core-field editing only — status transitions (approve/reject/suspend/hide)
// stay on their own dedicated endpoints, each with its own audit action and
// side effects (notifications, owner role promotion). Folding status into a
// generic PATCH would bypass all of that.
//
// Since Phase 15B this is the ONLY path by which staff (ADMIN/SUPER_ADMIN)
// edit another owner's profile fields — the public PATCH /businesses/:id is
// owner-only — so it carries every field the admin edit modal saves.
export class UpdateBusinessDto extends StaffReasonDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverPhoto?: string;

  @IsOptional()
  @IsBoolean()
  hasDelivery?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  deliveryFee?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  deliveryTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  telegram?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  instagram?: string;
}

// PUT /admin/businesses/:id/hours — the staff counterpart of the owner-only
// PUT /businesses/:id/hours. Wrapped (not a bare array) so it can carry the
// reason.
export class AdminBusinessHoursDto extends StaffReasonDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BusinessHourInputDto)
  hours: BusinessHourInputDto[];
}

// Targets the business's primary branch (falling back to its oldest branch
// if none is flagged primary) — an admin editing "the business's contact
// info" has no reason to pick among branches the way an owner managing their
// own listing might.
export class UpdateBusinessBranchDto extends StaffReasonDto {
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

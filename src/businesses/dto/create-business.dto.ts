import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// day: 0 = Monday … 6 = Sunday, matching BranchHour.dayOfWeek and
// BranchHourInputDto — kept as `day` here (not `dayOfWeek`) to match what
// the frontend's AddBusinessPage already sends.
class WorkingHourInputDto {
  @IsInt()
  @Min(0)
  @Max(6)
  day: number;

  @IsOptional()
  @IsString()
  openTime?: string | null;

  @IsOptional()
  @IsString()
  closeTime?: string | null;

  @IsOptional()
  @IsBoolean()
  isClosed?: boolean;
}

// Flat, single-request convenience shape for POST /businesses — under the
// hood this creates a Business plus its primary Branch (+ hours), the same
// two entities OwnerService.createMyBusiness / createBranch already handle
// separately via POST /me/businesses and POST /me/businesses/:id/branches.
export class CreateBusinessDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @IsInt()
  categoryId: number;

  // Not collected by the current frontend form (it only asks for a
  // category). Defaults to the first active BusinessType if omitted — see
  // BusinessesService.getDefaultBusinessTypeId. Should become a real field
  // in the client once the product decides how to surface it.
  @IsOptional()
  @IsInt()
  businessTypeId?: number;

  @IsOptional()
  @IsString()
  description?: string;

  @Matches(/^\+998\d{9}$/, { message: 'phone must be in the format +998XXXXXXXXX' })
  phone: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  secondaryPhone?: string;

  @IsInt()
  districtId: number;

  @IsOptional()
  @IsInt()
  cityId?: number;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  address: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  landmark?: string;

  // Accepted but not persisted — Branch has lat/lng for real map data, not a
  // free-text map-link column. Add one in a follow-up migration if the
  // product wants to keep the raw URL instead of/alongside coordinates.
  @IsOptional()
  @IsUrl()
  mapUrl?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  telegram?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  instagram?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;

  // Named `hours`, not `workingHours` — matches the field name the API's own
  // read responses already use for a branch's hours (branches[].hours), and
  // what the frontend actually sends.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkingHourInputDto)
  hours?: WorkingHourInputDto[];
}

import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class BranchHourInputDto {
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @IsOptional()
  @IsString()
  openTime?: string;

  @IsOptional()
  @IsString()
  closeTime?: string;

  @IsOptional()
  @IsBoolean()
  isClosed?: boolean;

  @IsOptional()
  @IsBoolean()
  is24Hours?: boolean;
}

// landmark/phoneAlt aren't explicitly named in the spec ("hours, address,
// phone, isPrimary") but are the same field family as address/phone —
// included so editing a branch isn't oddly incomplete.
export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  districtId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  landmark?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phoneAlt?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => BranchHourInputDto)
  hours?: BranchHourInputDto[];
}

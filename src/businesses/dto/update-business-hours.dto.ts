import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

// Body item for PUT /businesses/:id/hours — a plain array, matching
// BranchHour's shape (day/open/close/closed/24h), not a wrapper object.
export class BusinessHourInputDto {
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

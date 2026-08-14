import { Type } from 'class-transformer';
import { IsInt, IsOptional } from 'class-validator';

// Shared by overview/demographics/search-terms/peak-hours/competitors: when
// businessId is omitted, the service aggregates across every business the
// caller owns; when given, it drills into that one (ownership-checked).
export class AnalyticsScopeQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  businessId?: number;
}

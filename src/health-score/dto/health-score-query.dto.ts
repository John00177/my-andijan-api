import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class HealthScoreQueryDto {
  // An owner may hold several businesses. Omitted, the endpoint answers for
  // their oldest one — the sensible default for a dashboard landing page.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  businessId?: number;
}

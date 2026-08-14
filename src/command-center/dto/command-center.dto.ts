import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export enum GrowthPeriod {
  SEVEN_DAYS = '7d',
  THIRTY_DAYS = '30d',
  NINETY_DAYS = '90d',
}

export class GrowthQueryDto {
  @IsOptional()
  @IsIn(Object.values(GrowthPeriod))
  period?: GrowthPeriod = GrowthPeriod.SEVEN_DAYS;
}

export class AggregateDto {
  // Defaults to yesterday (the normal nightly-job behaviour). Pass an
  // explicit date to re-run a specific day.
  @IsOptional()
  @IsDateString()
  date?: string;

  // Re-aggregate this many days back from `date`, for backfilling history
  // after a gap or a first deploy.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  backfillDays?: number;
}

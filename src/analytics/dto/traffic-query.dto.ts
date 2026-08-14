import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional } from 'class-validator';

export enum TrafficPeriod {
  SEVEN_DAYS = '7d',
  THIRTY_DAYS = '30d',
  NINETY_DAYS = '90d',
}

export class TrafficQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  businessId?: number;

  @IsOptional()
  @IsIn(Object.values(TrafficPeriod))
  period?: TrafficPeriod = TrafficPeriod.SEVEN_DAYS;
}

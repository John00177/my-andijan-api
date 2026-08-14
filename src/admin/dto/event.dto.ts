import { Type } from 'class-transformer';
import { EventStatus } from '@prisma/client';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListEventsAdminQueryDto {
  @IsOptional()
  @IsIn(Object.values(EventStatus))
  status?: EventStatus;

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

export class RejectEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}

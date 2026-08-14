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

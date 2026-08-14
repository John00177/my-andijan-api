import { Type } from 'class-transformer';
import { ReportStatus } from '@prisma/client';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListReportsQueryDto {
  @IsOptional()
  @IsIn(Object.values(ReportStatus))
  status?: ReportStatus;

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

export enum ReportResolveAction {
  HIDE_REVIEW = 'HIDE_REVIEW',
  DISMISS = 'DISMISS',
}

export class ResolveReportDto {
  @IsIn(Object.values(ReportResolveAction))
  action: ReportResolveAction;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

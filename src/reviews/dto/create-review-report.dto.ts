import { ReportReason } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

// Maps 1:1 onto ReviewReport's user-supplied columns — reason (the existing
// ReportReason enum) and an optional free-text note. Status/resolution
// fields are moderator-owned and deliberately not accepted here.
export class CreateReviewReportDto {
  @IsEnum(ReportReason)
  reason: ReportReason;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

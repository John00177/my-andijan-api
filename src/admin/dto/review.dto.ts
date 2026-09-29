import { Type } from 'class-transformer';
import { ReviewStatus } from '@prisma/client';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListReviewsAdminQueryDto {
  @IsOptional()
  @IsIn(Object.values(ReviewStatus))
  status?: ReviewStatus;

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

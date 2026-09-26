import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Max, MaxLength, Min } from 'class-validator';

// Body for POST /businesses/:id/reviews — no branchId: the review is filed
// against the business's primary branch server-side (see
// ReviewsService.createForBusiness), the same "business-level convenience
// wraps a branch-scoped write" pattern PUT /businesses/:id/hours already
// uses for BranchHour.
export class CreateBusinessReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsString()
  @IsNotEmpty()
  comment: string;

  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  @Type(() => String)
  photos?: string[];
}

import { IsArray, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Max, MaxLength, Min } from 'class-validator';

export class CreateReviewDto {
  @IsInt()
  branchId: number;

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
  photos?: string[];
}

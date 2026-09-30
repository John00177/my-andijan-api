import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class SearchQueryDto {
  @IsString()
  @IsNotEmpty({ message: 'q must not be empty' })
  @MaxLength(200)
  q: string;

  @IsOptional()
  @IsString()
  category?: string;

  // Restricts the unified business+product result set to one kind. Added so
  // callers that can only render one kind (e.g. the public search page, which
  // reuses the business list card and has no product-result UI) get an
  // accurate total/pagination instead of a mixed count they can't fully
  // display. Omitted, both kinds are returned as before.
  @IsOptional()
  @IsIn(['business', 'product'])
  type?: 'business' | 'product';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  district?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  city?: number;

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

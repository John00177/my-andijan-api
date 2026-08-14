import { IsInt, IsNotEmpty, IsOptional, IsString, Min, MaxLength } from 'class-validator';

export class RecordSearchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  query: string;

  // "filters used" from the spec, broken out to match SearchQueryLog's columns.
  @IsOptional()
  @IsInt()
  categoryId?: number;

  @IsOptional()
  @IsInt()
  districtId?: number;

  @IsOptional()
  @IsInt()
  cityId?: number;

  // When present, this search is attributed to a specific business — it also
  // gets folded into that business's BusinessAnalytics.searchQueries for the
  // day (see AnalyticsService.recordSearch).
  @IsOptional()
  @IsInt()
  businessId?: number;

  @IsInt()
  @Min(0)
  resultCount: number;
}

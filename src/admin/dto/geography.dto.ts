import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateDistrictDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  nameUz?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  nameRu?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  nameEn?: string;
}

export class UpdateCityDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  nameUz?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  nameRu?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  nameEn?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  districtId?: number;
}

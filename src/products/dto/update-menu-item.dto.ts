import { IsBoolean, IsInt, IsOptional, IsString, Min, MaxLength } from 'class-validator';

export class UpdateMenuItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  photo?: string;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;
}

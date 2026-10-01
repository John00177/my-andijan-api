import { ProductType } from '@prisma/client';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min, MaxLength } from 'class-validator';

export class UpdateMenuItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsEnum(ProductType)
  type?: ProductType;

  @IsOptional()
  @IsInt()
  categoryId?: number;

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

  // isActive is the catalog's publish switch: GET /businesses/:id/menu and the
  // product side of GET /search both filter on it, so flipping it false hides
  // an item from customers and from search without deleting it. isAvailable is
  // the softer "temporarily sold out" flag and leaves the item listed.
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

import { ProductType } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, Min, MaxLength } from 'class-validator';

export class CreateMenuItemDto {
  @IsString()
  @MaxLength(200)
  name: string;

  // Product.type already exists on the model (PRODUCT | SERVICE) and defaults
  // to PRODUCT — exposed here so a service business can describe what it
  // actually sells instead of everything being filed as a product.
  @IsOptional()
  @IsEnum(ProductType)
  type?: ProductType;

  // Product.categoryId already exists and is what GET /search's product
  // category filter matches on (pc.slug), so setting it makes a catalog item
  // findable under its own category rather than only its business's.
  @IsOptional()
  @IsInt()
  categoryId?: number;

  @IsInt()
  @Min(0)
  price: number;

  @IsOptional()
  @IsString()
  description?: string;

  // Named `photo` to match the menu item's single-image shape the frontend
  // sends — maps onto Product.imageUrl, the same column Business/Branch
  // photos already use.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  photo?: string;
}

import { IsInt, IsOptional, IsString, Min, MaxLength } from 'class-validator';

export class CreateMenuItemDto {
  @IsString()
  @MaxLength(200)
  name: string;

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

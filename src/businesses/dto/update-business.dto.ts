import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

// Used by PATCH /businesses/:id — owner or ADMIN/MODERATOR/SUPER_ADMIN only
// (see BusinessesService.assertCanManage). All fields optional so callers
// can send a partial patch.
export class UpdateBusinessDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoryId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  logoUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverPhoto?: string;

  @IsOptional()
  @IsBoolean()
  hasDelivery?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  deliveryFee?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  deliveryTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  telegram?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  instagram?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  metaTitleUz?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  metaTitleRu?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  metaTitleEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  metaDescriptionUz?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  metaDescriptionRu?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  metaDescriptionEn?: string;
}

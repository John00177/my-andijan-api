import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

// The spec lists "phone" as an editable business field, but Business has no
// phone column — phone lives on Branch (a business can have several
// branches, each with its own number). Omitted here rather than guessed at;
// branch phone is editable via PATCH /me/branches/:id.
export class UpdateMyBusinessDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

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

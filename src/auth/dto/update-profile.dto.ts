import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Sent as multipart/form-data (the photo rides along), so every field arrives
 * as a string and there are no numeric/boolean coercions to worry about.
 *
 * The DB stores a single `fullName`; the signup UI collects first and last
 * separately, so both are accepted here and composed on the way in.
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Aziz' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(75)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Karimov' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(75)
  lastName?: string;

  /** Accepted as an alternative to firstName/lastName for existing callers. */
  @ApiPropertyOptional({ example: 'Aziz Karimov' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  fullName?: string;
}

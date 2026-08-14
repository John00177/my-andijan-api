import { Type } from 'class-transformer';
import { EventType } from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateMyEventDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(250)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  description?: string;

  @IsOptional()
  @IsIn(Object.values(EventType))
  type?: EventType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverUrl?: string;

  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsDateString()
  endAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  venueName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsBoolean()
  isFree?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  price?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  maxAttendees?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  registrationUrl?: string;

  @IsOptional()
  @IsBoolean()
  allowRsvp?: boolean;
}

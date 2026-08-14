import { IsDateString, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateEventDto {
  @IsInt()
  businessId: number;

  @IsString()
  @MinLength(3)
  @MaxLength(250)
  title: string;

  @IsString()
  @MinLength(10)
  description: string;

  @IsDateString()
  startAt: string;

  @IsDateString()
  endAt: string;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  venueName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;
}

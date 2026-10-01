import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateClaimDto {
  @IsInt()
  businessId: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  evidence?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  contactNote?: string;
}

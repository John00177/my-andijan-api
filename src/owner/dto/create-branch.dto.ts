import { IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateBranchDto {
  @IsInt()
  districtId: number;

  @IsOptional()
  @IsInt()
  cityId?: number;

  @IsString()
  @MaxLength(200)
  name: string;

  @IsString()
  @MaxLength(500)
  address: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  landmark?: string;

  @IsString()
  @MaxLength(20)
  phone: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phoneAlt?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

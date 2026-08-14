import { Type } from 'class-transformer';
import { ClaimStatus } from '@prisma/client';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListClaimsAdminQueryDto {
  @IsOptional()
  @IsIn(Object.values(ClaimStatus))
  status?: ClaimStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class RejectClaimDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}

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

// Phase 16 pilot policy: an approval must record HOW the claimant was verified
// (e.g. "called the phone already on the listing"), stored as the APPROVE
// audit row's note — there is deliberately no verification column on
// BusinessClaim (no migration). Required, unlike most audit notes, because an
// ownership grant with no recorded verification is exactly what claim
// hijacking looks like after the fact.
export class ApproveClaimDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  verificationNote: string;
}

export class RejectClaimDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}

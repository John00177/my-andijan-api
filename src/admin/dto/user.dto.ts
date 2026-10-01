import { Type } from 'class-transformer';
import { UserRole, UserStatus } from '@prisma/client';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

// Body of POST /admin/users/:id/suspend and /activate (Phase 15B). Every
// account-status change records why, as the audit row's note — required
// because an emergency freeze of an ADMIN is later reviewed by the platform
// owner, who needs the SUPER_ADMIN's stated reason.
export class UserStatusChangeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}

export class ListUsersAdminQueryDto {
  @IsOptional()
  @IsIn(Object.values(UserRole))
  role?: UserRole;

  @IsOptional()
  @IsIn(Object.values(UserStatus))
  status?: UserStatus;

  @IsOptional()
  @IsString()
  search?: string;

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

import { Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { HealthScoreService } from './health-score.service';
import { HealthScoreQueryDto } from './dto/health-score-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

// Owner-facing half. Ownership is enforced inside the service, which resolves
// the business from the authenticated user rather than trusting a path param.
@ApiTags('health-score')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class HealthScoreController {
  constructor(private readonly healthScoreService: HealthScoreService) {}

  @Get('health-score')
  getMyHealthScore(@CurrentUser() user: AuthenticatedUser, @Query() query: HealthScoreQueryDto) {
    return this.healthScoreService.getForOwner(user.id, query.businessId);
  }

  @Post('health-score/recommendations/:id/complete')
  completeRecommendation(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.healthScoreService.completeRecommendation(user.id, id);
  }
}

// Admin-facing half. Split into its own class purely because the guard stack
// differs — RolesGuard applies here and must not apply to the owner routes.
@ApiTags('health-score')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class HealthScoreAdminController {
  constructor(private readonly healthScoreService: HealthScoreService) {}

  // Full rebuild. Normally unnecessary — scores maintain themselves on write —
  // but needed after a backfill, a scoring-weight change, or a first deploy.
  @Post('health-scores/recalculate')
  recalculateAll() {
    return this.healthScoreService.recalculateAll();
  }
}

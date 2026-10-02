import { Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { HealthScoreService } from './health-score.service';
import { HealthScoreQueryDto } from './dto/health-score-query.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { RequireCapability } from '../authz/authz.decorators';

// Owner-facing half. Ownership is enforced inside the service, which resolves
// the business from the authenticated user rather than trusting a path param.
@ApiTags('health-score')
@ApiBearerAuth()
@Controller('me')
export class HealthScoreController {
  constructor(private readonly healthScoreService: HealthScoreService) {}

  @RequireCapability('business.manage_own')
  @Get('health-score')
  getMyHealthScore(@CurrentUser() user: AuthenticatedUser, @Query() query: HealthScoreQueryDto) {
    return this.healthScoreService.getForOwner(user.id, query.businessId);
  }

  @RequireCapability('business.manage_own')
  @Post('health-score/recommendations/:id/complete')
  completeRecommendation(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.healthScoreService.completeRecommendation(user.id, id);
  }
}

// Admin-facing half (`analytics.platform`), kept as its own class because it
// is mounted under /admin rather than /me.
@ApiTags('health-score')
@ApiBearerAuth()
@Controller('admin')
export class HealthScoreAdminController {
  constructor(private readonly healthScoreService: HealthScoreService) {}

  // Full rebuild. Normally unnecessary — scores maintain themselves on write —
  // but needed after a backfill, a scoring-weight change, or a first deploy.
  @RequireCapability('analytics.platform')
  @Post('health-scores/recalculate')
  recalculateAll() {
    return this.healthScoreService.recalculateAll();
  }
}

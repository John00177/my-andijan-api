import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AnalyticsService } from './analytics.service';
import { RecordViewDto } from './dto/record-view.dto';
import { RecordClickDto } from './dto/record-click.dto';
import { RecordSearchDto } from './dto/record-search.dto';
import { AnalyticsScopeQueryDto } from './dto/analytics-scope-query.dto';
import { TrafficQueryDto } from './dto/traffic-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

@ApiTags('analytics')
@Controller()
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  // ---- Collection (public, anonymous) ------------------------------------------

  @Post('analytics/view')
  recordView(@Body() dto: RecordViewDto) {
    return this.analyticsService.recordView(dto);
  }

  @Post('analytics/click')
  recordClick(@Body() dto: RecordClickDto) {
    return this.analyticsService.recordClick(dto);
  }

  @Post('analytics/search')
  recordSearch(@Body() dto: RecordSearchDto) {
    return this.analyticsService.recordSearch(dto);
  }

  // ---- Owner analytics (JWT + ownership) -----------------------------------------

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me/analytics/overview')
  getOverview(@CurrentUser() user: AuthenticatedUser, @Query() query: AnalyticsScopeQueryDto) {
    return this.analyticsService.getOverview(user.id, query.businessId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me/analytics/traffic')
  getTraffic(@CurrentUser() user: AuthenticatedUser, @Query() query: TrafficQueryDto) {
    return this.analyticsService.getTraffic(user.id, query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me/analytics/demographics')
  getDemographics(@CurrentUser() user: AuthenticatedUser, @Query() query: AnalyticsScopeQueryDto) {
    return this.analyticsService.getDemographics(user.id, query.businessId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me/analytics/search-terms')
  getSearchTerms(@CurrentUser() user: AuthenticatedUser, @Query() query: AnalyticsScopeQueryDto) {
    return this.analyticsService.getSearchTerms(user.id, query.businessId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me/analytics/peak-hours')
  getPeakHours(@CurrentUser() user: AuthenticatedUser, @Query() query: AnalyticsScopeQueryDto) {
    return this.analyticsService.getPeakHours(user.id, query.businessId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me/analytics/competitors')
  getCompetitors(@CurrentUser() user: AuthenticatedUser, @Query() query: AnalyticsScopeQueryDto) {
    return this.analyticsService.getCompetitors(user.id, query.businessId);
  }

  // ---- Platform-wide user analytics (SUPER_ADMIN only) ---------------------------

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Get('admin/analytics/users')
  getUserAnalytics() {
    return this.analyticsService.getUserAnalytics();
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Get('admin/analytics/dashboard')
  getDashboardAnalytics() {
    return this.analyticsService.getDashboardAnalytics();
  }
}

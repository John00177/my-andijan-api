import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { RecordViewDto } from './dto/record-view.dto';
import { RecordClickDto } from './dto/record-click.dto';
import { RecordSearchDto } from './dto/record-search.dto';
import { AnalyticsScopeQueryDto } from './dto/analytics-scope-query.dto';
import { TrafficQueryDto } from './dto/traffic-query.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { Public, RequireCapability } from '../authz/authz.decorators';

@ApiTags('analytics')
@Controller()
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  // ---- Collection (public, anonymous) ------------------------------------------

  @Public()
  @Post('analytics/view')
  recordView(@Body() dto: RecordViewDto) {
    return this.analyticsService.recordView(dto);
  }

  @Public()
  @Post('analytics/click')
  recordClick(@Body() dto: RecordClickDto) {
    return this.analyticsService.recordClick(dto);
  }

  @Public()
  @Post('analytics/search')
  recordSearch(@Body() dto: RecordSearchDto) {
    return this.analyticsService.recordSearch(dto);
  }

  // ---- Owner analytics (JWT + ownership) -----------------------------------------

  @ApiBearerAuth()
  @RequireCapability('business.manage_own')
  @Get('me/analytics/overview')
  getOverview(@CurrentUser() user: AuthenticatedUser, @Query() query: AnalyticsScopeQueryDto) {
    return this.analyticsService.getOverview(user.id, query.businessId);
  }

  @ApiBearerAuth()
  @RequireCapability('business.manage_own')
  @Get('me/analytics/traffic')
  getTraffic(@CurrentUser() user: AuthenticatedUser, @Query() query: TrafficQueryDto) {
    return this.analyticsService.getTraffic(user.id, query);
  }

  @ApiBearerAuth()
  @RequireCapability('business.manage_own')
  @Get('me/analytics/demographics')
  getDemographics(@CurrentUser() user: AuthenticatedUser, @Query() query: AnalyticsScopeQueryDto) {
    return this.analyticsService.getDemographics(user.id, query.businessId);
  }

  @ApiBearerAuth()
  @RequireCapability('business.manage_own')
  @Get('me/analytics/search-terms')
  getSearchTerms(@CurrentUser() user: AuthenticatedUser, @Query() query: AnalyticsScopeQueryDto) {
    return this.analyticsService.getSearchTerms(user.id, query.businessId);
  }

  @ApiBearerAuth()
  @RequireCapability('business.manage_own')
  @Get('me/analytics/peak-hours')
  getPeakHours(@CurrentUser() user: AuthenticatedUser, @Query() query: AnalyticsScopeQueryDto) {
    return this.analyticsService.getPeakHours(user.id, query.businessId);
  }

  @ApiBearerAuth()
  @RequireCapability('business.manage_own')
  @Get('me/analytics/competitors')
  getCompetitors(@CurrentUser() user: AuthenticatedUser, @Query() query: AnalyticsScopeQueryDto) {
    return this.analyticsService.getCompetitors(user.id, query.businessId);
  }

  // ---- Platform-wide user analytics (SUPER_ADMIN only) ---------------------------

  @ApiBearerAuth()
  @RequireCapability('analytics.users')
  @Get('admin/analytics/users')
  getUserAnalytics() {
    return this.analyticsService.getUserAnalytics();
  }

  @ApiBearerAuth()
  @RequireCapability('analytics.users')
  @Get('admin/analytics/dashboard')
  getDashboardAnalytics() {
    return this.analyticsService.getDashboardAnalytics();
  }
}

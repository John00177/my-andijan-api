import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CommandCenterService } from './command-center.service';
import { HealthScoreService } from '../health-score/health-score.service';
import { AggregateDto, GrowthQueryDto } from './dto/command-center.dto';
import { RequireCapability } from '../authz/authz.decorators';

@ApiTags('command-center')
@ApiBearerAuth()
@Controller('admin')
export class CommandCenterController {
  constructor(
    private readonly commandCenterService: CommandCenterService,
    private readonly healthScoreService: HealthScoreService,
  ) {}

  // Manual trigger for the nightly rollup. Also accepts a date and a
  // backfillDays window so history can be rebuilt on demand.
  @RequireCapability('analytics.platform')
  @Post('analytics/aggregate')
  aggregate(@Body() dto: AggregateDto) {
    return this.commandCenterService.aggregate(dto);
  }

  @RequireCapability('analytics.platform')
  @Get('command-center/overview')
  getOverview() {
    return this.commandCenterService.getOverview();
  }

  @RequireCapability('analytics.platform')
  @Get('command-center/growth')
  getGrowth(@Query() query: GrowthQueryDto) {
    return this.commandCenterService.getGrowth(query);
  }

  @RequireCapability('analytics.platform')
  @Get('command-center/geography')
  getGeography() {
    return this.commandCenterService.getGeography();
  }

  @RequireCapability('analytics.platform')
  @Get('command-center/categories')
  getCategories() {
    return this.commandCenterService.getCategories();
  }

  @RequireCapability('analytics.platform')
  @Get('command-center/search-intelligence')
  getSearchIntelligence() {
    return this.commandCenterService.getSearchIntelligence();
  }

  @RequireCapability('analytics.platform')
  @Get('command-center/users')
  getUsers() {
    return this.commandCenterService.getUsers();
  }

  @RequireCapability('analytics.platform')
  @Get('command-center/moderation')
  getModeration() {
    return this.commandCenterService.getModeration();
  }

  @RequireCapability('analytics.platform')
  @Get('command-center/business-health')
  getBusinessHealth() {
    return this.commandCenterService.getBusinessHealth();
  }

  // Distinct from business-health above: that one lists individual outliers
  // (top rated, struggling) computed live, this one reports the distribution of
  // the stored health scores across the platform.
  @RequireCapability('analytics.platform')
  @Get('command-center/health-overview')
  getHealthOverview() {
    return this.healthScoreService.getHealthOverview();
  }
}

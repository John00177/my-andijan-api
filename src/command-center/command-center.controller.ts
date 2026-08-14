import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CommandCenterService } from './command-center.service';
import { HealthScoreService } from '../health-score/health-score.service';
import { AggregateDto, GrowthQueryDto } from './dto/command-center.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('command-center')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class CommandCenterController {
  constructor(
    private readonly commandCenterService: CommandCenterService,
    private readonly healthScoreService: HealthScoreService,
  ) {}

  // Manual trigger for the nightly rollup. Also accepts a date and a
  // backfillDays window so history can be rebuilt on demand.
  @Post('analytics/aggregate')
  aggregate(@Body() dto: AggregateDto) {
    return this.commandCenterService.aggregate(dto);
  }

  @Get('command-center/overview')
  getOverview() {
    return this.commandCenterService.getOverview();
  }

  @Get('command-center/growth')
  getGrowth(@Query() query: GrowthQueryDto) {
    return this.commandCenterService.getGrowth(query);
  }

  @Get('command-center/geography')
  getGeography() {
    return this.commandCenterService.getGeography();
  }

  @Get('command-center/categories')
  getCategories() {
    return this.commandCenterService.getCategories();
  }

  @Get('command-center/search-intelligence')
  getSearchIntelligence() {
    return this.commandCenterService.getSearchIntelligence();
  }

  @Get('command-center/users')
  getUsers() {
    return this.commandCenterService.getUsers();
  }

  @Get('command-center/moderation')
  getModeration() {
    return this.commandCenterService.getModeration();
  }

  @Get('command-center/business-health')
  getBusinessHealth() {
    return this.commandCenterService.getBusinessHealth();
  }

  // Distinct from business-health above: that one lists individual outliers
  // (top rated, struggling) computed live, this one reports the distribution of
  // the stored health scores across the platform.
  @Get('command-center/health-overview')
  getHealthOverview() {
    return this.healthScoreService.getHealthOverview();
  }
}

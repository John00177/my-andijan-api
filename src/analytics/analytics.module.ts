import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsGate } from './analytics-gate';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsGate],
})
export class AnalyticsModule {}

import { Module } from '@nestjs/common';
import { OwnerController } from './owner.controller';
import { OwnerService } from './owner.service';
import { ReviewsModule } from '../reviews/reviews.module';
import { EventsModule } from '../events/events.module';
import { HealthScoreModule } from '../health-score/health-score.module';

@Module({
  imports: [ReviewsModule, EventsModule, HealthScoreModule],
  controllers: [OwnerController],
  providers: [OwnerService],
  // Exported so BusinessesModule can build POST /businesses as a thin
  // orchestrator over the existing create-business + create-branch logic
  // instead of duplicating it.
  exports: [OwnerService],
})
export class OwnerModule {}

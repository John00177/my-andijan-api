import { Module } from '@nestjs/common';
import { HealthScoreAdminController, HealthScoreController } from './health-score.controller';
import { HealthScoreService } from './health-score.service';

// Exported because the write hooks live in the modules that own the writes
// (reviews, owner) rather than here — see HealthScoreService.recalculateSafely.
@Module({
  controllers: [HealthScoreController, HealthScoreAdminController],
  providers: [HealthScoreService],
  exports: [HealthScoreService],
})
export class HealthScoreModule {}

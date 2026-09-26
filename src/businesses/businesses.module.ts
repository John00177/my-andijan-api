import { Module } from '@nestjs/common';
import { BusinessesController } from './businesses.controller';
import { BusinessesService } from './businesses.service';
import { OwnerModule } from '../owner/owner.module';
import { ReviewsModule } from '../reviews/reviews.module';

@Module({
  imports: [OwnerModule, ReviewsModule],
  controllers: [BusinessesController],
  providers: [BusinessesService],
})
export class BusinessesModule {}

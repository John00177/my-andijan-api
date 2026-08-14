import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { GeographyModule } from './geography/geography.module';
import { CategoriesModule } from './categories/categories.module';
import { BusinessesModule } from './businesses/businesses.module';
import { SearchModule } from './search/search.module';
import { ReviewsModule } from './reviews/reviews.module';
import { FavoritesModule } from './favorites/favorites.module';
import { EventsModule } from './events/events.module';
import { AdminModule } from './admin/admin.module';
import { OwnerModule } from './owner/owner.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { CommandCenterModule } from './command-center/command-center.module';
import { HealthScoreModule } from './health-score/health-score.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    GeographyModule,
    CategoriesModule,
    BusinessesModule,
    SearchModule,
    ReviewsModule,
    FavoritesModule,
    EventsModule,
    AdminModule,
    OwnerModule,
    AnalyticsModule,
    CommandCenterModule,
    HealthScoreModule,
  ],
})
export class AppModule {}

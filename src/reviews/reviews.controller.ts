import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { UpdateReviewDto } from './dto/update-review.dto';
import { CreateReplyDto } from './dto/create-reply.dto';
import { CreateReviewReportDto } from './dto/create-review-report.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { Public, RequireCapability } from '../authz/authz.decorators';

@ApiTags('reviews')
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @ApiBearerAuth()
  @RequireCapability('review.write')
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateReviewDto) {
    return this.reviewsService.create(user.id, dto);
  }

  @Public()
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.reviewsService.findOne(id);
  }

  @ApiBearerAuth()
  @RequireCapability('review.write')
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateReviewDto,
  ) {
    return this.reviewsService.update(id, user.id, dto);
  }

  @ApiBearerAuth()
  @RequireCapability('review.write')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.reviewsService.remove(id, user.id);
  }

  // `review.report` (every role). Moderation of the resulting report happens
  // on /admin/reports (`report.resolve`, D-72/D-75).
  @ApiBearerAuth()
  @RequireCapability('review.report')
  @Post(':id/report')
  report(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReviewReportDto,
  ) {
    return this.reviewsService.report(id, user.id, dto);
  }

  // `business.manage_own` + OWNERSHIP: ReviewsService.reply requires that the
  // caller owns the reviewed business — a reply speaks as the business
  // (D-74/D-75).
  @ApiBearerAuth()
  @RequireCapability('business.manage_own')
  @Post(':id/reply')
  reply(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReplyDto,
  ) {
    return this.reviewsService.reply(id, user, dto);
  }

  // PATCH alias of the route above — "reply" reads more like updating the
  // review resource's reply than creating a new one, and callers may expect
  // either verb. Both hit the same ownership-checked service method; POST is
  // kept so nothing already using it breaks.
  @ApiBearerAuth()
  @RequireCapability('business.manage_own')
  @Patch(':id/reply')
  replyPatch(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReplyDto,
  ) {
    return this.reviewsService.reply(id, user, dto);
  }
}

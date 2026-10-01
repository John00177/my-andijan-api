import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { UpdateReviewDto } from './dto/update-review.dto';
import { CreateReplyDto } from './dto/create-reply.dto';
import { CreateReviewReportDto } from './dto/create-review-report.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

@ApiTags('reviews')
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateReviewDto) {
    return this.reviewsService.create(user.id, dto);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.reviewsService.findOne(id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateReviewDto,
  ) {
    return this.reviewsService.update(id, user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.reviewsService.remove(id, user.id);
  }

  // Any signed-in user can report a visible review — same authentication
  // model as writing one (POST /reviews), no role floor. Moderation of the
  // resulting report happens on /admin/reports (MODERATOR+, D-72).
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post(':id/report')
  report(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReviewReportDto,
  ) {
    return this.reviewsService.report(id, user.id, dto);
  }

  // Owner-only (Phase 15B, D-74): ReviewsService.reply requires that the
  // caller owns the reviewed business. No @Roles floor — a reply speaks as
  // the business, so rank must never be what admits someone here.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
  @Patch(':id/reply')
  replyPatch(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReplyDto,
  ) {
    return this.reviewsService.reply(id, user, dto);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseArrayPipe,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { BusinessesService } from './businesses.service';
import { ListBusinessesQueryDto } from './dto/list-businesses-query.dto';
import { CreateBusinessDto } from './dto/create-business.dto';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { BusinessHourInputDto } from './dto/update-business-hours.dto';
import { ReviewsService } from '../reviews/reviews.service';
import { CreateBusinessReviewDto } from '../reviews/dto/create-business-review.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

@ApiTags('businesses')
@Controller('businesses')
export class BusinessesController {
  constructor(
    private readonly businessesService: BusinessesService,
    private readonly reviewsService: ReviewsService,
  ) {}

  // Floor is CUSTOMER — the lowest role in the list — so under the hierarchy
  // guard ANY authenticated user can submit a business. It always lands as
  // PENDING; the submitter's role is untouched until an admin/moderator
  // approves it (see AdminService.approveBusiness).
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER, UserRole.BUSINESS_OWNER, UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateBusinessDto) {
    return this.businessesService.createForOwner(user, dto);
  }

  // SUPER_ADMIN only — not even the owning BUSINESS_OWNER can delete their
  // own listing. Use /admin/businesses/:id/hide or /suspend for reversible
  // moderation; this is the one irreversible action in the business
  // lifecycle, deliberately withheld from ADMIN and MODERATOR too.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.businessesService.remove(id, admin.id);
  }

  // Owner-only (Phase 15B, D-74): authentication here, OWNERSHIP in the
  // service, and deliberately no @Roles — a rank floor is what used to let
  // SUPPORT/MODERATOR through. Staff edits go via PATCH /admin/businesses/:id.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateBusinessDto,
  ) {
    return this.businessesService.update(id, user, dto);
  }

  // Same owner-only rule as PATCH :id — replaces the primary branch's hours
  // wholesale (delete-then-create) from a plain array body. Staff use
  // PUT /admin/businesses/:id/hours.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Put(':id/hours')
  updateHours(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ParseArrayPipe({ items: BusinessHourInputDto })) hours: BusinessHourInputDto[],
  ) {
    return this.businessesService.updateHours(id, user, hours);
  }

  // Must be declared before ':id' so these literals aren't swallowed as an id/slug.
  @Get('featured')
  findFeatured() {
    return this.businessesService.findFeatured();
  }

  @Get('promoted')
  findPromoted() {
    return this.businessesService.findPromoted();
  }

  @Get()
  findAll(@Query() query: ListBusinessesQueryDto) {
    return this.businessesService.findAll(query);
  }

  // Accepts either a numeric id or a slug (see BusinessesService.findOne).
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.businessesService.findOne(id);
  }

  // Flattens reviews across every branch of the business — see
  // ReviewsService.findForBusiness for why (reviews are branch-scoped in
  // storage, but a caller reading/writing "the business's reviews" shouldn't
  // need a branch id).
  @Get(':id/reviews')
  findReviews(@Param('id', ParseIntPipe) id: number) {
    return this.reviewsService.findForBusiness(id);
  }

  // Floor is CUSTOMER, matching POST /businesses — any authenticated user
  // can leave a review; the one-review-per-branch-per-user unique
  // constraint (inherited from ReviewsService.create) is the anti-spam
  // control, not a role gate.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER, UserRole.BUSINESS_OWNER, UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post(':id/reviews')
  createReview(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBusinessReviewDto,
  ) {
    return this.reviewsService.createForBusiness(user.id, id, dto);
  }
}

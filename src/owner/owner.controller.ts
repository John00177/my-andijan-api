import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { OwnerService } from './owner.service';
import { CreateMyBusinessDto } from './dto/create-my-business.dto';
import { UpdateMyBusinessDto } from './dto/update-my-business.dto';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { UpdateMyEventDto } from './dto/update-my-event.dto';
import { PaginationQueryDto } from './dto/pagination.dto';
import { CreateClaimDto } from './dto/create-claim.dto';
import { CreateReplyDto } from '../reviews/dto/create-reply.dto';
import { CreateEventDto } from '../events/dto/create-event.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { RequireCapability } from '../authz/authz.decorators';

@ApiTags('owner')
@ApiBearerAuth()
@Controller('me')
export class OwnerController {
  constructor(private readonly ownerService: OwnerService) {}

  @RequireCapability('business.manage_own')
  @Get('stats')
  getStats(@CurrentUser() user: AuthenticatedUser) {
    return this.ownerService.getStats(user.id);
  }

  // ---- Businesses -------------------------------------------------------------

  @RequireCapability('business.manage_own')
  @Get('businesses')
  findMyBusinesses(@CurrentUser() user: AuthenticatedUser) {
    return this.ownerService.findMyBusinesses(user.id);
  }

  @RequireCapability('business.create')
  @Post('businesses')
  createMyBusiness(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateMyBusinessDto) {
    return this.ownerService.createMyBusiness(user, dto);
  }

  @RequireCapability('business.manage_own')
  @Get('businesses/:id')
  findMyBusinessById(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.ownerService.findMyBusinessById(user.id, id);
  }

  @RequireCapability('business.manage_own')
  @Patch('businesses/:id')
  updateMyBusiness(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMyBusinessDto,
  ) {
    return this.ownerService.updateMyBusiness(user.id, id, dto);
  }

  @RequireCapability('business.manage_own')
  @Post('businesses/:id/branches')
  createBranch(
    @Param('id', ParseIntPipe) businessId: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBranchDto,
  ) {
    return this.ownerService.createBranch(user.id, businessId, dto);
  }

  // ---- Branches -----------------------------------------------------------------

  @RequireCapability('business.manage_own')
  @Patch('branches/:id')
  updateBranch(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.ownerService.updateBranch(user.id, id, dto);
  }

  // ---- Reviews --------------------------------------------------------------------

  @RequireCapability('business.manage_own')
  @Get('reviews')
  findMyReviews(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationQueryDto) {
    return this.ownerService.findMyReviews(user.id, query);
  }

  @RequireCapability('business.manage_own')
  @Post('reviews/:id/reply')
  replyToReview(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReplyDto,
  ) {
    return this.ownerService.replyToReview(id, user, dto);
  }

  // ---- Events -----------------------------------------------------------------------

  @RequireCapability('business.manage_own')
  @Get('events')
  findMyEvents(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationQueryDto) {
    return this.ownerService.findMyEvents(user.id, query);
  }

  @RequireCapability('business.manage_own')
  @Post('events')
  createMyEvent(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateEventDto) {
    return this.ownerService.createMyEvent(user, dto);
  }

  @RequireCapability('business.manage_own')
  @Patch('events/:id')
  updateMyEvent(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMyEventDto,
  ) {
    return this.ownerService.updateMyEvent(user.id, id, dto);
  }

  @RequireCapability('business.manage_own')
  @Delete('events/:id')
  removeMyEvent(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.ownerService.removeMyEvent(user.id, id);
  }

  // ---- Claims -------------------------------------------------------------------------

  @RequireCapability('business.claim')
  @Get('claims')
  findMyClaims(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationQueryDto) {
    return this.ownerService.findMyClaims(user.id, query);
  }

  // Floor is "any authenticated user" (same as POST /businesses) — a claim is
  // how an unverified representative first establishes a relationship to a
  // business, so it can't require already being a BUSINESS_OWNER.
  @RequireCapability('business.claim')
  @Post('claims')
  createClaim(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateClaimDto) {
    return this.ownerService.createClaim(user, dto);
  }
}

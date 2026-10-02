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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import {
  AdminBusinessHoursDto,
  ListBusinessesAdminQueryDto,
  PromoteBusinessDto,
  RejectBusinessDto,
  SuspendBusinessDto,
  UpdateBusinessBranchDto,
  UpdateBusinessDto,
} from './dto/business.dto';
import { ListClaimsAdminQueryDto, RejectClaimDto } from './dto/claim.dto';
import { ListReportsQueryDto, ResolveReportDto } from './dto/report.dto';
import { ListEventsAdminQueryDto, RejectEventDto } from './dto/event.dto';
import { CreateCategoryDto, ReorderCategoryItemDto, UpdateCategoryDto } from './dto/category.dto';
import { UpdateCityDto, UpdateDistrictDto } from './dto/geography.dto';
import { ListUsersAdminQueryDto, UserStatusChangeDto } from './dto/user.dto';
import { ListAuditQueryDto } from './dto/audit.dto';
import { ListReviewsAdminQueryDto } from './dto/review.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { RequireCapability } from '../authz/authz.decorators';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ---- 1. Dashboard ----------------------------------------------------------

  @RequireCapability('analytics.platform')
  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  // ---- 2. Business moderation -------------------------------------------------

  // `business.review` (MODERATOR, ADMIN, SUPER_ADMIN — D-72/D-75): the queue
  // moderators act on. Owner phone/email are returned only to holders of
  // `user.pii.read`.
  @RequireCapability('business.review')
  @Get('businesses')
  findBusinesses(@Query() query: ListBusinessesAdminQueryDto, @CurrentUser() viewer: AuthenticatedUser) {
    return this.adminService.findBusinesses(query, viewer.role);
  }

  // `business.review`, and never on a listing the moderator owns (conflict
  // of interest, enforced in the service — D-75).
  @RequireCapability('business.review')
  @Post('businesses/:id/approve')
  approveBusiness(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.approveBusiness(id, admin.id);
  }

  @RequireCapability('business.review')
  @Post('businesses/:id/reject')
  rejectBusiness(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: RejectBusinessDto,
  ) {
    return this.adminService.rejectBusiness(id, admin.id, dto);
  }

  // `business.hide` (SUPER_ADMIN only) — pulls a live listing out of
  // search/detail pages without deleting it. Distinct from /suspend
  // (`business.operate`) in who may pull the trigger.
  @RequireCapability('business.hide')
  @Patch('businesses/:id/hide')
  hideBusiness(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.hideBusiness(id, admin.id);
  }

  // Reversal of /hide, same `business.hide` capability (Phase 14, D-73). Restores
  // the status recorded at hide time, or PENDING when none was recorded.
  @RequireCapability('business.hide')
  @Patch('businesses/:id/unhide')
  unhideBusiness(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.unhideBusiness(id, admin.id);
  }

  @RequireCapability('business.edit_any')
  @Patch('businesses/:id')
  updateBusiness(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UpdateBusinessDto,
  ) {
    return this.adminService.updateBusiness(id, admin.id, dto);
  }

  // Staff counterpart of the owner-only PUT /businesses/:id/hours (Phase 15B):
  // `business.edit_any`, a required reason, an audit row.
  @RequireCapability('business.edit_any')
  @Put('businesses/:id/hours')
  updateBusinessHours(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: AdminBusinessHoursDto,
  ) {
    return this.adminService.updateBusinessHours(id, admin.id, dto.reason, dto.hours);
  }

  @RequireCapability('business.edit_any')
  @Patch('businesses/:id/branch')
  updateBusinessBranch(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UpdateBusinessBranchDto,
  ) {
    return this.adminService.updateBusinessBranch(id, admin.id, dto);
  }

  @RequireCapability('business.operate')
  @Post('businesses/:id/verify')
  verifyBusiness(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.verifyBusiness(id, admin.id);
  }

  // Reversals below (unverify/unsuspend/unpromote) inherit the class-level
  // `business.operate` — the same capability as the action they undo.
  @RequireCapability('business.operate')
  @Post('businesses/:id/unverify')
  unverifyBusiness(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.unverifyBusiness(id, admin.id);
  }

  @RequireCapability('business.operate')
  @Post('businesses/:id/suspend')
  suspendBusiness(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: SuspendBusinessDto,
  ) {
    return this.adminService.suspendBusiness(id, admin.id, dto);
  }

  @RequireCapability('business.operate')
  @Post('businesses/:id/unsuspend')
  unsuspendBusiness(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.unsuspendBusiness(id, admin.id);
  }

  @RequireCapability('business.operate')
  @Post('businesses/:id/promote')
  promoteBusiness(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: PromoteBusinessDto,
  ) {
    return this.adminService.promoteBusiness(id, admin.id, dto);
  }

  @RequireCapability('business.operate')
  @Post('businesses/:id/unpromote')
  unpromoteBusiness(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.unpromoteBusiness(id, admin.id);
  }

  // ---- 3. Claims ------------------------------------------------------------

  @RequireCapability('claim.review')
  @Get('claims')
  findClaims(@Query() query: ListClaimsAdminQueryDto) {
    return this.adminService.findClaims(query);
  }

  @RequireCapability('claim.review')
  @Post('claims/:id/approve')
  approveClaim(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.approveClaim(id, admin.id);
  }

  @RequireCapability('claim.review')
  @Post('claims/:id/reject')
  rejectClaim(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: RejectClaimDto,
  ) {
    return this.adminService.rejectClaim(id, admin.id, dto);
  }

  // ---- 4. Reviews & reports ---------------------------------------------------

  // Review & report moderation: `review.moderate` / `report.resolve`
  // (MODERATOR, ADMIN, SUPER_ADMIN — D-72/D-75). The reporter is reduced to
  // an id for callers without `user.pii.read`.
  @RequireCapability('report.resolve')
  @Get('reports')
  findReports(@Query() query: ListReportsQueryDto, @CurrentUser() viewer: AuthenticatedUser) {
    return this.adminService.findReports(query, viewer.role);
  }

  @RequireCapability('report.resolve')
  @Post('reports/:id/resolve')
  resolveReport(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: ResolveReportDto,
  ) {
    return this.adminService.resolveReport(id, admin.id, dto);
  }

  @RequireCapability('review.moderate')
  @Get('reviews')
  findReviews(@Query() query: ListReviewsAdminQueryDto) {
    return this.adminService.findReviews(query);
  }

  @RequireCapability('review.moderate')
  @Post('reviews/:id/hide')
  hideReview(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.hideReview(id, admin.id);
  }

  @RequireCapability('review.moderate')
  @Post('reviews/:id/restore')
  restoreReview(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.restoreReview(id, admin.id);
  }

  // ---- 5. Events --------------------------------------------------------------

  @RequireCapability('event.review')
  @Get('events')
  findEvents(@Query() query: ListEventsAdminQueryDto) {
    return this.adminService.findEvents(query);
  }

  @RequireCapability('event.review')
  @Post('events/:id/approve')
  approveEvent(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.approveEvent(id, admin.id);
  }

  @RequireCapability('event.review')
  @Post('events/:id/reject')
  rejectEvent(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: RejectEventDto,
  ) {
    return this.adminService.rejectEvent(id, admin.id, dto);
  }

  // ---- 6. Categories ----------------------------------------------------------

  @RequireCapability('taxonomy.manage')
  @Get('categories')
  findCategories() {
    return this.adminService.findCategories();
  }

  @RequireCapability('taxonomy.manage')
  @Post('categories')
  createCategory(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateCategoryDto) {
    return this.adminService.createCategory(admin.id, dto);
  }

  // Must be declared before 'categories/:id' so "reorder" isn't swallowed
  // as an :id value.
  @RequireCapability('taxonomy.manage')
  @Patch('categories/reorder')
  reorderCategories(
    @CurrentUser() admin: AuthenticatedUser,
    @Body(new ParseArrayPipe({ items: ReorderCategoryItemDto })) items: ReorderCategoryItemDto[],
  ) {
    return this.adminService.reorderCategories(admin.id, items);
  }

  @RequireCapability('taxonomy.manage')
  @Patch('categories/:id')
  updateCategory(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.adminService.updateCategory(id, admin.id, dto);
  }

  @RequireCapability('taxonomy.manage')
  @Delete('categories/:id')
  deleteCategory(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.deleteCategory(id, admin.id);
  }

  // ---- 7. Geography -------------------------------------------------------------

  @RequireCapability('taxonomy.manage')
  @Patch('districts/:id')
  updateDistrict(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UpdateDistrictDto,
  ) {
    return this.adminService.updateDistrict(id, admin.id, dto);
  }

  @RequireCapability('taxonomy.manage')
  @Patch('cities/:id')
  updateCity(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UpdateCityDto,
  ) {
    return this.adminService.updateCity(id, admin.id, dto);
  }

  // ---- 8. Users ---------------------------------------------------------------

  @RequireCapability('user.pii.read')
  @Get('users')
  findUsers(@Query() query: ListUsersAdminQueryDto) {
    return this.adminService.findUsers(query);
  }

  // `user.status.manage` gets a caller here; WHICH accounts that caller may suspend or
  // reinstate is decided per target in the service (user-status.policy.ts,
  // Phase 15B): never yourself, never a SUPER_ADMIN, ADMIN only over
  // CUSTOMER/BUSINESS_OWNER, SUPER_ADMIN also over MODERATOR/SUPPORT and an
  // emergency freeze of an ADMIN.
  @RequireCapability('user.status.manage')
  @Post('users/:id/suspend')
  suspendUser(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UserStatusChangeDto,
  ) {
    return this.adminService.suspendUser(id, admin, dto.reason);
  }

  @RequireCapability('user.status.manage')
  @Post('users/:id/activate')
  activateUser(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UserStatusChangeDto,
  ) {
    return this.adminService.activateUser(id, admin, dto.reason);
  }

  // ---- 9. Audit ----------------------------------------------------------------

  @RequireCapability('audit.read')
  @Get('audit')
  findAuditLogs(@Query() query: ListAuditQueryDto) {
    return this.adminService.findAuditLogs(query);
  }
}

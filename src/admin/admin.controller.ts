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
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ---- 1. Dashboard ----------------------------------------------------------

  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  // ---- 2. Business moderation -------------------------------------------------

  // MODERATOR+ (Phase 14, D-72): moderators need the PENDING queue to act on
  // approve/reject. Owner phone/email are stripped for MODERATOR in the
  // service; every other business route stays ADMIN-only.
  @Roles(UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('businesses')
  findBusinesses(@Query() query: ListBusinessesAdminQueryDto, @CurrentUser() viewer: AuthenticatedUser) {
    return this.adminService.findBusinesses(query, viewer.role);
  }

  // Overrides the class-level @Roles(ADMIN) floor down to MODERATOR for
  // these two actions specifically — moderation is exactly what MODERATOR
  // exists for.
  @Roles(UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('businesses/:id/approve')
  approveBusiness(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.approveBusiness(id, admin.id);
  }

  @Roles(UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('businesses/:id/reject')
  rejectBusiness(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: RejectBusinessDto,
  ) {
    return this.adminService.rejectBusiness(id, admin.id, dto);
  }

  // SUPER_ADMIN only — pulls a live listing out of search/detail pages
  // without deleting it. Distinct from /suspend (ADMIN-level, reversible
  // moderation action already above) in who's allowed to pull the trigger.
  @Roles(UserRole.SUPER_ADMIN)
  @Patch('businesses/:id/hide')
  hideBusiness(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.hideBusiness(id, admin.id);
  }

  // Reversal of /hide, same SUPER_ADMIN-only floor (Phase 14, D-73). Restores
  // the status recorded at hide time, or PENDING when none was recorded.
  @Roles(UserRole.SUPER_ADMIN)
  @Patch('businesses/:id/unhide')
  unhideBusiness(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.unhideBusiness(id, admin.id);
  }

  @Patch('businesses/:id')
  updateBusiness(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UpdateBusinessDto,
  ) {
    return this.adminService.updateBusiness(id, admin.id, dto);
  }

  // Staff counterpart of the owner-only PUT /businesses/:id/hours (Phase 15B):
  // ADMIN floor from the class, a required reason, an audit row.
  @Put('businesses/:id/hours')
  updateBusinessHours(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: AdminBusinessHoursDto,
  ) {
    return this.adminService.updateBusinessHours(id, admin.id, dto.reason, dto.hours);
  }

  @Patch('businesses/:id/branch')
  updateBusinessBranch(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UpdateBusinessBranchDto,
  ) {
    return this.adminService.updateBusinessBranch(id, admin.id, dto);
  }

  @Post('businesses/:id/verify')
  verifyBusiness(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.verifyBusiness(id, admin.id);
  }

  // Reversals below (unverify/unsuspend/unpromote) inherit the class-level
  // ADMIN floor — the same level as the action they undo. No lower override.
  @Post('businesses/:id/unverify')
  unverifyBusiness(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.unverifyBusiness(id, admin.id);
  }

  @Post('businesses/:id/suspend')
  suspendBusiness(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: SuspendBusinessDto,
  ) {
    return this.adminService.suspendBusiness(id, admin.id, dto);
  }

  @Post('businesses/:id/unsuspend')
  unsuspendBusiness(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.unsuspendBusiness(id, admin.id);
  }

  @Post('businesses/:id/promote')
  promoteBusiness(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: PromoteBusinessDto,
  ) {
    return this.adminService.promoteBusiness(id, admin.id, dto);
  }

  @Post('businesses/:id/unpromote')
  unpromoteBusiness(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.unpromoteBusiness(id, admin.id);
  }

  // ---- 3. Claims ------------------------------------------------------------

  @Get('claims')
  findClaims(@Query() query: ListClaimsAdminQueryDto) {
    return this.adminService.findClaims(query);
  }

  @Post('claims/:id/approve')
  approveClaim(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.approveClaim(id, admin.id);
  }

  @Post('claims/:id/reject')
  rejectClaim(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: RejectClaimDto,
  ) {
    return this.adminService.rejectClaim(id, admin.id, dto);
  }

  // ---- 4. Reviews & reports ---------------------------------------------------

  // Review & report moderation is MODERATOR+ (Phase 14, D-72). The reporter
  // is reduced to an id for MODERATOR in the service.
  @Roles(UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('reports')
  findReports(@Query() query: ListReportsQueryDto, @CurrentUser() viewer: AuthenticatedUser) {
    return this.adminService.findReports(query, viewer.role);
  }

  @Roles(UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('reports/:id/resolve')
  resolveReport(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: ResolveReportDto,
  ) {
    return this.adminService.resolveReport(id, admin.id, dto);
  }

  @Roles(UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('reviews')
  findReviews(@Query() query: ListReviewsAdminQueryDto) {
    return this.adminService.findReviews(query);
  }

  @Roles(UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('reviews/:id/hide')
  hideReview(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.hideReview(id, admin.id);
  }

  @Roles(UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('reviews/:id/restore')
  restoreReview(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.restoreReview(id, admin.id);
  }

  // ---- 5. Events --------------------------------------------------------------

  @Get('events')
  findEvents(@Query() query: ListEventsAdminQueryDto) {
    return this.adminService.findEvents(query);
  }

  @Post('events/:id/approve')
  approveEvent(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.approveEvent(id, admin.id);
  }

  @Post('events/:id/reject')
  rejectEvent(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: RejectEventDto,
  ) {
    return this.adminService.rejectEvent(id, admin.id, dto);
  }

  // ---- 6. Categories ----------------------------------------------------------

  @Get('categories')
  findCategories() {
    return this.adminService.findCategories();
  }

  @Post('categories')
  createCategory(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateCategoryDto) {
    return this.adminService.createCategory(admin.id, dto);
  }

  // Must be declared before 'categories/:id' so "reorder" isn't swallowed
  // as an :id value.
  @Patch('categories/reorder')
  reorderCategories(
    @CurrentUser() admin: AuthenticatedUser,
    @Body(new ParseArrayPipe({ items: ReorderCategoryItemDto })) items: ReorderCategoryItemDto[],
  ) {
    return this.adminService.reorderCategories(admin.id, items);
  }

  @Patch('categories/:id')
  updateCategory(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.adminService.updateCategory(id, admin.id, dto);
  }

  @Delete('categories/:id')
  deleteCategory(@Param('id', ParseIntPipe) id: number, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.deleteCategory(id, admin.id);
  }

  // ---- 7. Geography -------------------------------------------------------------

  @Patch('districts/:id')
  updateDistrict(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UpdateDistrictDto,
  ) {
    return this.adminService.updateDistrict(id, admin.id, dto);
  }

  @Patch('cities/:id')
  updateCity(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UpdateCityDto,
  ) {
    return this.adminService.updateCity(id, admin.id, dto);
  }

  // ---- 8. Users ---------------------------------------------------------------

  @Get('users')
  findUsers(@Query() query: ListUsersAdminQueryDto) {
    return this.adminService.findUsers(query);
  }

  // ADMIN floor gets a caller here; WHICH accounts that caller may suspend or
  // reinstate is decided per target in the service (user-status.policy.ts,
  // Phase 15B): never yourself, never a SUPER_ADMIN, ADMIN only over
  // CUSTOMER/BUSINESS_OWNER, SUPER_ADMIN also over MODERATOR/SUPPORT and an
  // emergency freeze of an ADMIN.
  @Post('users/:id/suspend')
  suspendUser(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UserStatusChangeDto,
  ) {
    return this.adminService.suspendUser(id, admin, dto.reason);
  }

  @Post('users/:id/activate')
  activateUser(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UserStatusChangeDto,
  ) {
    return this.adminService.activateUser(id, admin, dto.reason);
  }

  // ---- 9. Audit ----------------------------------------------------------------

  @Get('audit')
  findAuditLogs(@Query() query: ListAuditQueryDto) {
    return this.adminService.findAuditLogs(query);
  }
}

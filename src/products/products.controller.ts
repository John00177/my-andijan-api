import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ProductsService } from './products.service';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

// Nested under /businesses (same base path BusinessesController uses) rather
// than a route of its own, so a business's menu reads as part of the
// business resource: GET/POST /businesses/:id/menu.
@ApiTags('menu')
@Controller('businesses')
export class BusinessMenuController {
  constructor(private readonly productsService: ProductsService) {}

  @Get(':id/menu')
  findAll(@Param('id', ParseIntPipe) id: number) {
    return this.productsService.findForBusiness(id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.BUSINESS_OWNER, UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post(':id/menu')
  create(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMenuItemDto,
  ) {
    return this.productsService.create(id, user, dto);
  }
}

// The owner-side read of the same catalog, under /me like every other owner
// resource (/me/businesses, /me/reviews, /me/events, /me/claims). Not a
// duplicate of GET /businesses/:id/menu: that one is public and shows only
// active items of an APPROVED business, this one is ownership-checked and
// shows deactivated items too so they can be managed and re-published.
@ApiTags('menu')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.BUSINESS_OWNER, UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('me/businesses')
export class OwnerMenuController {
  constructor(private readonly productsService: ProductsService) {}

  @Get(':id/menu')
  findMine(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.productsService.findForOwner(id, user);
  }
}

@ApiTags('menu')
@Controller('menu')
export class MenuItemController {
  constructor(private readonly productsService: ProductsService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.BUSINESS_OWNER, UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMenuItemDto,
  ) {
    return this.productsService.update(id, user, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.BUSINESS_OWNER, UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.productsService.remove(id, user);
  }
}

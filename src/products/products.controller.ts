import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { Public, RequireCapability } from '../authz/authz.decorators';

// Every catalog write (and the owner-side read) needs `business.manage_own`
// AND ownership of the business, checked in ProductsService (D-74/D-75).
// SUPPORT and MODERATOR hold no owner capability; no role bypasses ownership.

// Nested under /businesses (same base path BusinessesController uses) rather
// than a route of its own, so a business's menu reads as part of the
// business resource: GET/POST /businesses/:id/menu.
@ApiTags('menu')
@Controller('businesses')
export class BusinessMenuController {
  constructor(private readonly productsService: ProductsService) {}

  @Public()
  @Get(':id/menu')
  findAll(@Param('id', ParseIntPipe) id: number) {
    return this.productsService.findForBusiness(id);
  }

  @ApiBearerAuth()
  @RequireCapability('business.manage_own')
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
@Controller('me/businesses')
export class OwnerMenuController {
  constructor(private readonly productsService: ProductsService) {}

  @RequireCapability('business.manage_own')
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
  @RequireCapability('business.manage_own')
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMenuItemDto,
  ) {
    return this.productsService.update(id, user, dto);
  }

  @ApiBearerAuth()
  @RequireCapability('business.manage_own')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.productsService.remove(id, user);
  }
}

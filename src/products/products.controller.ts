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

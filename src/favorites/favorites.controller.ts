import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FavoritesService } from './favorites.service';
import { CreateFavoriteDto } from './dto/create-favorite.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { Authenticated } from '../authz/authz.decorators';

@ApiTags('favorites')
@ApiBearerAuth()
@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  @Authenticated()
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateFavoriteDto) {
    return this.favoritesService.create(user.id, dto);
  }

  @Authenticated()
  @Delete(':businessId')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('businessId', ParseIntPipe) businessId: number) {
    return this.favoritesService.remove(user.id, businessId);
  }

  @Authenticated()
  @Get()
  findMine(@CurrentUser() user: AuthenticatedUser) {
    return this.favoritesService.findMine(user.id);
  }
}

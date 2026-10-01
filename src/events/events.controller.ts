import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { EventsService } from './events.service';
import { ListEventsQueryDto } from './dto/list-events-query.dto';
import { CreateEventDto } from './dto/create-event.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Get()
  findAll(@Query() query: ListEventsQueryDto) {
    return this.eventsService.findAll(query);
  }

  // Owner-only (Phase 15B, D-74): EventsService.create requires that the
  // caller owns the business. No @Roles floor — it let SUPPORT/MODERATOR in
  // by rank while adding nothing the ownership check doesn't already enforce.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateEventDto) {
    return this.eventsService.create(user, dto);
  }

  @Get(':slug')
  findBySlug(@Param('slug') slug: string) {
    return this.eventsService.findBySlug(slug);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post(':slug/attend')
  attend(@Param('slug') slug: string, @CurrentUser() user: AuthenticatedUser) {
    return this.eventsService.attend(slug, user.id);
  }
}

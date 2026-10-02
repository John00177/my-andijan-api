import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { EventsService } from './events.service';
import { ListEventsQueryDto } from './dto/list-events-query.dto';
import { CreateEventDto } from './dto/create-event.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { Public, Authenticated, RequireCapability } from '../authz/authz.decorators';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Public()
  @Get()
  findAll(@Query() query: ListEventsQueryDto) {
    return this.eventsService.findAll(query);
  }

  // `business.manage_own` + OWNERSHIP: EventsService.create requires that the
  // caller owns the business (D-74/D-75).
  @ApiBearerAuth()
  @RequireCapability('business.manage_own')
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateEventDto) {
    return this.eventsService.create(user, dto);
  }

  @Public()
  @Get(':slug')
  findBySlug(@Param('slug') slug: string) {
    return this.eventsService.findBySlug(slug);
  }

  @ApiBearerAuth()
  @Authenticated()
  @Post(':slug/attend')
  attend(@Param('slug') slug: string, @CurrentUser() user: AuthenticatedUser) {
    return this.eventsService.attend(slug, user.id);
  }
}

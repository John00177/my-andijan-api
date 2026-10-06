import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AttendeeStatus, EventStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { ListEventsQueryDto } from './dto/list-events-query.dto';
import { CreateEventDto } from './dto/create-event.dto';
import { slugBase } from '../common/slug';

const EVENT_LIST_SELECT = {
  id: true,
  slug: true,
  title: true,
  type: true,
  coverUrl: true,
  startAt: true,
  endAt: true,
  venueName: true,
  address: true,
  isFree: true,
  price: true,
  currency: true,
  attendeeCount: true,
  business: { select: { id: true, slug: true, name: true, logoUrl: true } },
  district: { select: { id: true, slug: true, nameUz: true } },
  category: { select: { id: true, slug: true, nameUz: true, nameRu: true, nameEn: true } },
} satisfies Prisma.EventSelect;

@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListEventsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.EventWhereInput = {
      status: EventStatus.PUBLISHED,
      deletedAt: null,
      ...(query.district ? { districtId: query.district } : {}),
      ...(query.category ? { category: { slug: query.category } } : {}),
      ...(query.upcoming ? { startAt: { gte: new Date() } } : {}),
    };

    const [events, total] = await this.prisma.$transaction([
      this.prisma.event.findMany({
        where,
        select: EVENT_LIST_SELECT,
        orderBy: { startAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.event.count({ where }),
    ]);

    return {
      data: events,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  async findBySlug(slug: string) {
    const event = await this.prisma.event.findFirst({
      where: { slug, status: EventStatus.PUBLISHED, deletedAt: null },
      include: {
        business: { select: { id: true, slug: true, name: true, logoUrl: true } },
        district: { select: { id: true, slug: true, nameUz: true } },
        category: { select: { id: true, slug: true, nameUz: true, nameRu: true, nameEn: true } },
        // Live count of active RSVPs, independent of the denormalized
        // attendeeCount column — this is the detail view, correctness beats
        // the cheap read the list view uses.
        _count: {
          select: {
            attendees: { where: { status: { not: AttendeeStatus.CANCELLED } } },
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundException(`Event "${slug}" not found`);
    }

    const { _count, ...rest } = event;
    return { ...rest, attendeeCount: _count.attendees };
  }

  async attend(slug: string, userId: number) {
    const event = await this.prisma.event.findFirst({ where: { slug, deletedAt: null } });
    if (!event) {
      throw new NotFoundException(`Event "${slug}" not found`);
    }
    if (event.status !== EventStatus.PUBLISHED) {
      throw new ForbiddenException('This event is not open for RSVPs');
    }
    if (!event.allowRsvp) {
      throw new ForbiddenException('RSVP is not enabled for this event');
    }

    const existing = await this.prisma.eventAttendee.findUnique({
      where: { eventId_userId: { eventId: event.id, userId } },
    });

    // Already an active RSVP — idempotent, no double count.
    if (existing && existing.status !== AttendeeStatus.CANCELLED) {
      return existing;
    }

    if (event.maxAttendees !== null) {
      const activeCount = await this.prisma.eventAttendee.count({
        where: { eventId: event.id, status: { not: AttendeeStatus.CANCELLED } },
      });
      if (activeCount >= event.maxAttendees) {
        throw new ConflictException('Event has reached maximum capacity');
      }
    }

    const [attendee] = await this.prisma.$transaction([
      existing
        ? this.prisma.eventAttendee.update({
            where: { id: existing.id },
            data: { status: AttendeeStatus.GOING },
          })
        : this.prisma.eventAttendee.create({
            data: { eventId: event.id, userId, status: AttendeeStatus.GOING },
          }),
      this.prisma.event.update({
        where: { id: event.id },
        data: { attendeeCount: { increment: 1 } },
      }),
    ]);

    return attendee;
  }

  async create(user: AuthenticatedUser, dto: CreateEventDto) {
    const business = await this.prisma.business.findFirst({
      where: { id: dto.businessId, deletedAt: null },
      include: {
        businessType: true,
        branches: {
          where: { deletedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          take: 1,
        },
      },
    });

    if (!business) {
      throw new NotFoundException(`Business ${dto.businessId} not found`);
    }
    if (business.ownerId !== user.id) {
      throw new ForbiddenException('You do not own this business');
    }
    if (!business.businessType.eventsEnabled) {
      throw new ForbiddenException('This business type cannot create events');
    }

    const primaryBranch = business.branches[0];
    if (!primaryBranch) {
      // Event.districtId is required and has no location of its own — it
      // borrows the district from the business's primary branch.
      throw new BadRequestException('Business must have at least one branch before creating events');
    }

    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    if (endAt <= startAt) {
      throw new BadRequestException('endAt must be after startAt');
    }

    const slug = await this.generateUniqueSlug(dto.title);

    return this.prisma.event.create({
      data: {
        businessId: business.id,
        districtId: primaryBranch.districtId,
        slug,
        title: dto.title,
        description: dto.description,
        venueName: dto.venueName,
        address: dto.address,
        startAt,
        endAt,
        // Goes through admin moderation (see AdminService.approveEvent) —
        // not auto-published.
        status: EventStatus.PENDING,
      },
      include: {
        business: { select: { id: true, slug: true, name: true } },
        district: { select: { id: true, slug: true, nameUz: true } },
      },
    });
  }

  private async generateUniqueSlug(title: string): Promise<string> {
    // Cyrillic transliterated, never empty, never all digits (Phase 16F.2).
    const base = slugBase(title, 'event');

    let slug = base;
    let suffix = 1;
    while (await this.prisma.event.findUnique({ where: { slug } })) {
      suffix += 1;
      slug = `${base}-${suffix}`;
    }
    return slug;
  }
}

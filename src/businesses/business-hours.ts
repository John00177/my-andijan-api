import { NotFoundException } from '@nestjs/common';
import { BranchHour, Prisma } from '@prisma/client';
import { BusinessHourInputDto } from './dto/update-business-hours.dto';

// Hours live on Branch, not Business — this replaces the primary branch's
// hours wholesale, since that's the single set the business page shows.
// Shared by the owner route (PUT /businesses/:id/hours) and the audited admin
// route (PUT /admin/businesses/:id/hours); authorization is the CALLER's job.
// Must run inside the caller's transaction so delete+create is atomic.
export async function replacePrimaryBranchHours(
  tx: Prisma.TransactionClient,
  businessId: number,
  hours: BusinessHourInputDto[],
): Promise<{ branchId: number; before: BranchHour[]; after: BranchHour[] }> {
  const primaryBranch = await tx.branch.findFirst({
    where: { businessId, deletedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
  if (!primaryBranch) {
    throw new NotFoundException(`Business ${businessId} has no branch to attach hours to`);
  }

  const before = await tx.branchHour.findMany({
    where: { branchId: primaryBranch.id },
    orderBy: { dayOfWeek: 'asc' },
  });

  await tx.branchHour.deleteMany({ where: { branchId: primaryBranch.id } });

  if (hours.length) {
    await tx.branchHour.createMany({
      data: hours.map((hour) => ({
        branchId: primaryBranch.id,
        dayOfWeek: hour.dayOfWeek,
        openTime: hour.openTime,
        closeTime: hour.closeTime,
        isClosed: hour.isClosed ?? false,
        is24Hours: hour.is24Hours ?? false,
      })),
    });
  }

  const after = await tx.branchHour.findMany({
    where: { branchId: primaryBranch.id },
    orderBy: { dayOfWeek: 'asc' },
  });

  return { branchId: primaryBranch.id, before, after };
}

// One-off: promote the founder account to SUPER_ADMIN and fix the display
// name if it's still the placeholder "john".
//   railway run npx ts-node scripts/promote-super-admin.ts
import { PrismaClient, UserRole, AuditAction } from '@prisma/client';

const prisma = new PrismaClient();

const PHONE = '+998994796431';
const FULL_NAME = 'Jamoliddin';

async function main() {
  const user = await prisma.user.findUnique({ where: { phone: PHONE } });
  if (!user) {
    throw new Error(`User ${PHONE} not found`);
  }

  const data: { role: UserRole; fullName?: string } = { role: UserRole.SUPER_ADMIN };
  if (user.fullName.toLowerCase() === 'john') {
    data.fullName = FULL_NAME;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.user.update({ where: { id: user.id }, data });
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: AuditAction.ROLE_CHANGE,
        entityType: 'User',
        entityId: user.id,
        before: { role: user.role, fullName: user.fullName },
        after: { role: result.role, fullName: result.fullName },
        note: 'Founder promotion to SUPER_ADMIN',
      },
    });
    return result;
  });

  console.log(`Updated user ${updated.id}: role=${updated.role}, fullName="${updated.fullName}"`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

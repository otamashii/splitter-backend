import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, username: true, uniqueId: true, email: true }
  });
  console.log('--- USERS IN DB ---');
  console.log(JSON.stringify(users, null, 2));
  console.log('-------------------');
}

main().catch(console.error).finally(() => prisma.$disconnect());

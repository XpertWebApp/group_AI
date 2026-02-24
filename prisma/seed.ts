import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
    console.log('Seeding database...');

    // Create Admin Role
    const adminRole = await prisma.userRole.upsert({
        where: { name: 'ADMIN' },
        update: {},
        create: {
            name: 'ADMIN',
            description: 'Administrator with full access',
        },
    });

    // Create User Role
    await prisma.userRole.upsert({
        where: { name: 'USER' },
        update: {},
        create: {
            name: 'USER',
            description: 'Standard user',
        },
    });

    // Create Admin User
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await prisma.user.upsert({
        where: { email: 'admin@sett.ai' },
        update: {},
        create: {
            email: 'admin@sett.ai',
            password: hashedPassword,
            firstName: 'Admin',
            lastName: 'User',
            roleId: adminRole.id,
            isActive: true,
        },
    });

    console.log('Seeding completed.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

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

    // Create staff accounts
    const staffUsers = [
        { email: 'kira@s-e-t-t.com', password: 'm86UG00(1Gm/', firstName: 'Kira', lastName: '' },
        { email: 'oliwia@s-e-t-t.com', password: 'cfD59Oq>y6=#', firstName: 'Oliwia', lastName: '' },
        { email: 'simone@s-e-t-t.com', password: '2pS08a1$g>mo', firstName: 'Simone', lastName: '' },
        { email: 'dani@s-e-t-t.com', password: 'j3K9F6_&nvOx', firstName: 'Dani', lastName: '' },
        { email: 'cissy@s-e-t-t.com', password: 'yJwbuQ7-W202', firstName: 'Cissy', lastName: '' },
        { email: 'louise@s-e-t-t.com', password: '02d3o£6Ofi:$', firstName: 'Louise', lastName: '' },
    ];

    const userRole = await prisma.userRole.upsert({
        where: { name: 'USER' },
        update: {},
        create: { name: 'USER', description: 'Standard user' },
    });

    for (const u of staffUsers) {
        const hashed = await bcrypt.hash(u.password, 10);
        await prisma.user.upsert({
            where: { email: u.email },
            update: { password: hashed },
            create: {
                email: u.email,
                password: hashed,
                firstName: u.firstName,
                lastName: u.lastName,
                roleId: userRole.id,
                isActive: true,
            },
        });
        console.log(`  ✓ ${u.email}`);
    }

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

/**
 * Seeds the dedicated end-to-end test account.
 *
 * The e2e suite previously logged in as `admin@sett.ai` with the password from
 * `prisma/seed.ts`. That password has since diverged from the database, so every
 * e2e test failed at the login step. Pointing the suite at a real staff account
 * would only move the problem — those passwords change, and a test run should
 * never depend on a human's credentials.
 *
 * This account exists solely for automated tests:
 *   - `.test.local` domain, so it can never be confused with a staff account
 *   - password lives in `.env.test` alongside the suite that uses it
 *   - idempotent: re-running resets the password rather than erroring, so a
 *     drifted account is repaired instead of duplicated
 *
 * Usage:
 *   npm run seed:test-user
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

/** Kept in sync with `.env.test`; both are committed for local development. */
const TEST_USER = {
    email: 'e2e@test.local',
    password: 'E2eTest!2026',
    firstName: 'E2E',
    lastName: 'Test',
    /** ADMIN because the suite exercises admin-gated routes (approve, settings). */
    roleName: 'ADMIN',
};

async function main() {
    const role = await prisma.userRole.findUnique({ where: { name: TEST_USER.roleName } });
    if (!role) {
        throw new Error(
            `Role "${TEST_USER.roleName}" not found. Run \`npm run seed\` first to create the base roles.`,
        );
    }

    const hashed = await bcrypt.hash(TEST_USER.password, 10);

    const user = await prisma.user.upsert({
        where: { email: TEST_USER.email },
        // Reset the password and reactivate on every run, so an account that
        // drifted or was deactivated is repaired rather than left broken.
        update: { password: hashed, isActive: true, roleId: role.id },
        create: {
            email: TEST_USER.email,
            password: hashed,
            firstName: TEST_USER.firstName,
            lastName: TEST_USER.lastName,
            roleId: role.id,
            isActive: true,
        },
        select: { id: true, email: true, isActive: true },
    });

    console.log('\n✓ E2E test user ready');
    console.log(`  email:    ${user.email}`);
    console.log(`  password: ${TEST_USER.password}`);
    console.log(`  role:     ${TEST_USER.roleName}`);
    console.log(`  id:       ${user.id}`);
    console.log('\n  Matches TEST_USER_EMAIL / TEST_USER_PASSWORD in .env.test\n');
}

main()
    .catch((e) => {
        console.error('Failed to seed test user:', e.message);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

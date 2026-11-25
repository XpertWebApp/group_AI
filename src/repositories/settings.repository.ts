import { PrismaClient, SettingCategory } from '@prisma/client';

const prisma = new PrismaClient();

export class SettingsRepository {
    /**
     * Get all settings for a given category as a key-value map.
     */
    async getByCategory(category: SettingCategory): Promise<Record<string, string | null>> {
        const rows = await prisma.setting.findMany({ where: { category } });
        const result: Record<string, string | null> = {};
        for (const row of rows) {
            result[row.key] = row.value;
        }
        return result;
    }

    /**
     * Get a single setting value.
     */
    async get(category: SettingCategory, key: string): Promise<string | null> {
        const row = await prisma.setting.findUnique({
            where: { category_key: { category, key } },
        });
        return row?.value ?? null;
    }

    /**
     * Upsert multiple settings for a category.
     */
    async upsertMany(category: SettingCategory, data: Record<string, string>): Promise<void> {
        const operations = Object.entries(data).map(([key, value]) =>
            prisma.setting.upsert({
                where: { category_key: { category, key } },
                update: { value },
                create: { category, key, value },
            }),
        );
        await prisma.$transaction(operations);
    }

    /**
     * Get all settings grouped by category (for the settings overview page).
     */
    async getAll(): Promise<Record<string, Record<string, string | null>>> {
        const rows = await prisma.setting.findMany({ orderBy: { category: 'asc' } });
        const result: Record<string, Record<string, string | null>> = {};
        for (const row of rows) {
            if (!result[row.category]) result[row.category] = {};
            result[row.category][row.key] = row.value;
        }
        return result;
    }

    /**
     * Get the last updated timestamp per category (for the settings overview cards).
     */
    async getLastUpdatedByCategory(): Promise<Record<string, Date | null>> {
        const categories = Object.values(SettingCategory);
        const result: Record<string, Date | null> = {};

        for (const category of categories) {
            const row = await prisma.setting.findFirst({
                where: { category },
                orderBy: { updatedAt: 'desc' },
                select: { updatedAt: true },
            });
            result[category] = row?.updatedAt ?? null;
        }

        return result;
    }
}

export default new SettingsRepository();

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsRepository = void 0;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
class SettingsRepository {
    /**
     * Get all settings for a given category as a key-value map.
     */
    async getByCategory(category) {
        const rows = await prisma.setting.findMany({ where: { category } });
        const result = {};
        for (const row of rows) {
            result[row.key] = row.value;
        }
        return result;
    }
    /**
     * Get a single setting value.
     */
    async get(category, key) {
        const row = await prisma.setting.findUnique({
            where: { category_key: { category, key } },
        });
        return row?.value ?? null;
    }
    /**
     * Upsert multiple settings for a category.
     */
    async upsertMany(category, data) {
        const operations = Object.entries(data).map(([key, value]) => prisma.setting.upsert({
            where: { category_key: { category, key } },
            update: { value },
            create: { category, key, value },
        }));
        await prisma.$transaction(operations);
    }
    /**
     * Get all settings grouped by category (for the settings overview page).
     */
    async getAll() {
        const rows = await prisma.setting.findMany({ orderBy: { category: 'asc' } });
        const result = {};
        for (const row of rows) {
            if (!result[row.category])
                result[row.category] = {};
            result[row.category][row.key] = row.value;
        }
        return result;
    }
    /**
     * Get the last updated timestamp per category (for the settings overview cards).
     */
    async getLastUpdatedByCategory() {
        const categories = Object.values(client_1.SettingCategory);
        const result = {};
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
exports.SettingsRepository = SettingsRepository;
exports.default = new SettingsRepository();

import { SettingCategory } from '@prisma/client';
export declare class SettingsRepository {
    /**
     * Get all settings for a given category as a key-value map.
     */
    getByCategory(category: SettingCategory): Promise<Record<string, string | null>>;
    /**
     * Get a single setting value.
     */
    get(category: SettingCategory, key: string): Promise<string | null>;
    /**
     * Upsert multiple settings for a category.
     */
    upsertMany(category: SettingCategory, data: Record<string, string>): Promise<void>;
    /**
     * Get all settings grouped by category (for the settings overview page).
     */
    getAll(): Promise<Record<string, Record<string, string | null>>>;
    /**
     * Get the last updated timestamp per category (for the settings overview cards).
     */
    getLastUpdatedByCategory(): Promise<Record<string, Date | null>>;
}
declare const _default: SettingsRepository;
export default _default;

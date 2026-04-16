/**
 * GIATA Sync Service
 *
 * Orchestrates syncing hotel content from GIATA APIs into the local database.
 * Supports: full sync, incremental sync (changedSince), single hotel sync,
 * resolving missing GIATA codes via Multicodes, and handling moved properties.
 *
 * Schedule (managed by cron.service.ts):
 *  - Daily 2:00 AM UTC: incrementalSync (changes since yesterday)
 *  - Weekly Sunday 3:00 AM UTC: fullSync (all hotels with giataCode)
 */
interface SyncResult {
    total: number;
    synced: number;
    skipped: number;
    errors: number;
    duration: number;
}
declare class GiataSyncService {
    /**
     * Sync all GIATA data for a single hotel.
     * Fetches: texts (EN+DE), images, fact sheet, Multicodes mappings.
     */
    syncHotel(hotelCode: string, giataId: string): Promise<boolean>;
    /**
     * Full sync: iterate all hotels in master DB that have a giataCode.
     * Uses SyncJob for progress tracking and resume-on-interrupt.
     */
    fullSync(): Promise<SyncResult>;
    /**
     * Incremental sync: fetch hotels changed since a given date from GIATA,
     * cross-reference with our DB, and re-sync only the matched hotels.
     * Uses SyncJob for progress tracking.
     */
    incrementalSync(since?: Date): Promise<SyncResult>;
    /**
     * For hotels without a giataCode but with a supplierCode,
     * try resolving via GIATA Multicodes GDS lookup.
     */
    resolveMissingGiataCodes(): Promise<{
        resolved: number;
        skipped: number;
    }>;
    /**
     * Check for properties that were moved/merged in GIATA and update our giataCode.
     */
    handleMovedProperties(since?: Date): Promise<number>;
    /** Get sync status overview for admin dashboard. */
    getStatus(): Promise<{
        isConfigured: boolean;
        statusCounts: Record<string, number>;
        latestFullSync: any;
        latestIncrementalSync: any;
    }>;
}
declare const _default: GiataSyncService;
export default _default;

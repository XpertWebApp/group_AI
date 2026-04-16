"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const giata_client_service_1 = __importDefault(require("./giata.client.service"));
const giata_repository_1 = __importDefault(require("../repositories/giata.repository"));
const audit_1 = require("../utils/audit");
const logger_1 = __importDefault(require("../utils/logger"));
const SYNC_LANGUAGES = ['en', 'de'];
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const CONCURRENT_HOTELS = 3;
async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function withRetry(fn, retries = MAX_RETRIES) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            if (attempt === retries)
                return null;
            logger_1.default.warn({ attempt, err: err.message }, 'GIATA sync: retrying after failure');
            await sleep(RETRY_DELAY_MS * attempt);
        }
    }
    return null;
}
class GiataSyncService {
    // ─── Single Hotel Sync ──────────────────────────────────────────────
    /**
     * Sync all GIATA data for a single hotel.
     * Fetches: texts (EN+DE), images, fact sheet, Multicodes mappings.
     */
    async syncHotel(hotelCode, giataId) {
        console.log(`[GIATA] Syncing hotel ${hotelCode} (giataId: ${giataId})`);
        logger_1.default.info({ hotelCode, giataId }, 'GIATA sync: starting single hotel');
        try {
            // 1. Texts (EN + DE)
            for (const lang of SYNC_LANGUAGES) {
                const textResult = await withRetry(() => giata_client_service_1.default.getTexts(lang, giataId));
                if (textResult && textResult.sections.length > 0) {
                    await giata_repository_1.default.upsertTexts(hotelCode, giataId, textResult.sections.map((s) => ({
                        lang,
                        sectionType: s.sectionType,
                        title: s.title,
                        content: s.content,
                        lastUpdate: textResult.lastUpdate,
                    })));
                    console.log(`[GIATA]   Texts (${lang}): ${textResult.sections.length} sections stored`);
                }
                else {
                    console.log(`[GIATA]   Texts (${lang}): not available`);
                }
            }
            // 2. Images
            const imageResult = await withRetry(() => giata_client_service_1.default.getImages(giataId));
            if (imageResult && imageResult.images.length > 0) {
                let order = 0;
                const imageRows = imageResult.images.map((img) => {
                    const small = img.sizes.find((s) => s.maxwidth === '74');
                    const medium = img.sizes.find((s) => s.maxwidth === '320');
                    const large = img.sizes.find((s) => s.maxwidth === '800');
                    return {
                        imageType: img.type,
                        displayOrder: order++,
                        urlSmall: small?.url,
                        urlMedium: medium?.url,
                        urlLarge: large?.url,
                        lastUpdate: img.lastUpdate,
                    };
                });
                await giata_repository_1.default.upsertImages(hotelCode, giataId, imageRows);
                console.log(`[GIATA]   Images: ${imageRows.length} stored`);
            }
            else {
                console.log(`[GIATA]   Images: not available`);
            }
            // 3. Fact sheet
            const factResult = await withRetry(() => giata_client_service_1.default.getFactSheet(giataId));
            if (factResult && factResult.facts.length > 0) {
                const factRows = factResult.facts.map((f) => ({
                    sectionType: f.sectionType,
                    sectionName: f.sectionName,
                    factId: f.factId,
                    factName: f.factName,
                    typeHint: f.typeHint,
                    value: String(f.values[0]?.value ?? ''),
                    unit: f.values[0]?.unit,
                    fee: f.values[0]?.fee,
                })).filter((f) => f.value);
                await giata_repository_1.default.upsertFacts(hotelCode, giataId, factRows);
                console.log(`[GIATA]   Facts: ${factRows.length} stored`);
            }
            else {
                console.log(`[GIATA]   Facts: not available`);
            }
            // 4. Multicodes mappings
            const propertyResult = await withRetry(() => giata_client_service_1.default.getPropertyDetails(giataId));
            if (propertyResult && propertyResult.providers.length > 0) {
                const mappingRows = propertyResult.providers.map((p) => ({
                    providerCode: p.providerCode,
                    providerType: p.providerType,
                    codeValue: p.codeValues.join('|'),
                }));
                await giata_repository_1.default.upsertMappings(hotelCode, giataId, mappingRows);
                console.log(`[GIATA]   Mappings: ${mappingRows.length} providers stored`);
            }
            else {
                console.log(`[GIATA]   Mappings: not available`);
            }
            // 5. Mark hotel as synced
            await giata_repository_1.default.updateGiataStatus(hotelCode, 'synced');
            console.log(`[GIATA] ✓ Hotel ${hotelCode} synced successfully`);
            logger_1.default.info({ hotelCode, giataId }, 'GIATA sync: hotel completed');
            return true;
        }
        catch (err) {
            console.log(`[GIATA] ✗ Hotel ${hotelCode} FAILED: ${err.message}`);
            logger_1.default.error({ err: err.message, hotelCode, giataId }, 'GIATA sync: hotel failed');
            await giata_repository_1.default.updateGiataStatus(hotelCode, 'error');
            return false;
        }
    }
    // ─── Full Sync (with SyncJob resume) ───────────────────────────────
    /**
     * Full sync: iterate all hotels in master DB that have a giataCode.
     * Uses SyncJob for progress tracking and resume-on-interrupt.
     */
    async fullSync() {
        const start = Date.now();
        const JOB_TYPE = 'GIATA_FULL_SYNC';
        // 1. Check for in-progress job (resume) or create new one
        let job = await giata_repository_1.default.getInProgressJob(JOB_TYPE);
        if (!job) {
            const totalRecords = await giata_repository_1.default.countHotelsWithGiataCode();
            job = await giata_repository_1.default.createSyncJob(JOB_TYPE, totalRecords);
            console.log(`[GIATA] Full sync: starting new job ${job.id} (${totalRecords} hotels)`);
            logger_1.default.info({ jobId: job.id, totalRecords }, 'GIATA full sync: starting new job');
        }
        else {
            console.log(`[GIATA] Full sync: RESUMING job ${job.id} from key "${job.lastProcessedKey}" (${job.processedRecords} already done)`);
            logger_1.default.info({ jobId: job.id, lastKey: job.lastProcessedKey, processed: job.processedRecords }, 'GIATA full sync: resuming');
        }
        let synced = 0;
        let skipped = 0;
        let errors = 0;
        let processed = job.processedRecords ?? 0;
        const batchSize = 100;
        try {
            // 2. Fetch all hotels with giataCode, ordered by hotelCode (for deterministic resume)
            let offset = 0;
            while (true) {
                const hotels = await giata_repository_1.default.getHotelsWithGiataCode({ limit: batchSize, offset });
                if (hotels.length === 0)
                    break;
                // 3. Skip hotels already processed (resume)
                let startIdx = 0;
                if (job.lastProcessedKey && offset === 0) {
                    const lastIdx = hotels.findIndex((h) => h.hotelCode === job.lastProcessedKey);
                    if (lastIdx !== -1) {
                        startIdx = lastIdx + 1;
                        console.log(`[GIATA] Skipping ${startIdx} already-processed hotels in first batch`);
                    }
                    // If not found in first batch, the resume key was in an earlier batch — skip entirely
                    if (lastIdx === -1 && processed > 0) {
                        offset += batchSize;
                        continue;
                    }
                }
                // 4. Process remaining hotels in this batch
                for (let i = startIdx; i < hotels.length; i += CONCURRENT_HOTELS) {
                    const chunk = hotels.slice(i, Math.min(i + CONCURRENT_HOTELS, hotels.length));
                    const results = await Promise.allSettled(chunk.map((h) => this.syncHotel(h.hotelCode, h.giataCode)));
                    for (const r of results) {
                        if (r.status === 'fulfilled' && r.value)
                            synced++;
                        else
                            errors++;
                    }
                    processed += chunk.length;
                    const lastKey = chunk[chunk.length - 1].hotelCode;
                    // 5. Update progress after each chunk (resume point)
                    await giata_repository_1.default.updateSyncJob(job.id, {
                        processedRecords: processed,
                        lastProcessedKey: lastKey,
                    });
                }
                offset += batchSize;
                console.log(`[GIATA] Full sync progress: ${processed} processed, ${synced} synced, ${errors} errors`);
            }
            // 6. Handle moved properties
            try {
                const moved = await this.handleMovedProperties();
                console.log(`[GIATA] Moved properties handled: ${moved}`);
            }
            catch (err) {
                logger_1.default.warn({ err: err.message }, 'GIATA full sync: failed to handle moved properties');
            }
            // 7. Mark job as completed
            const duration = Date.now() - start;
            await giata_repository_1.default.updateSyncJob(job.id, {
                status: 'COMPLETED',
                completedAt: new Date(),
                processedRecords: processed,
            });
            console.log(`[GIATA] Full sync COMPLETED: ${synced} synced, ${errors} errors, ${Math.floor(duration / 1000)}s`);
            logger_1.default.info({ synced, skipped, errors, durationMs: duration }, 'GIATA full sync: completed');
            await (0, audit_1.logAuditEvent)({
                action: 'giata_full_sync',
                entity: 'hotel',
                details: { total: processed, synced, skipped, errors, durationMs: duration },
            });
            return { total: processed, synced, skipped, errors, duration };
        }
        catch (err) {
            // Mark job as failed (but keep lastProcessedKey for resume)
            await giata_repository_1.default.updateSyncJob(job.id, {
                status: 'FAILED',
                errorMessage: err.message,
                completedAt: new Date(),
            });
            console.log(`[GIATA] Full sync FAILED at ${processed} records: ${err.message}`);
            logger_1.default.error({ err: err.message, processed }, 'GIATA full sync: failed');
            throw err;
        }
    }
    // ─── Incremental Sync (with SyncJob tracking) ───────────────────────
    /**
     * Incremental sync: fetch hotels changed since a given date from GIATA,
     * cross-reference with our DB, and re-sync only the matched hotels.
     * Uses SyncJob for progress tracking.
     */
    async incrementalSync(since) {
        const start = Date.now();
        const JOB_TYPE = 'GIATA_INCREMENTAL_SYNC';
        const sinceDate = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
        const sinceStr = sinceDate.toISOString().split('T')[0];
        console.log(`[GIATA] Incremental sync: checking changes since ${sinceStr}`);
        logger_1.default.info({ since: sinceStr }, 'GIATA incremental sync: starting');
        // Get changed GIATA IDs from MHG
        const changedItems = await giata_client_service_1.default.getItemsChangedSince(sinceStr);
        if (changedItems.length === 0) {
            console.log('[GIATA] Incremental sync: no changes found');
            return { total: 0, synced: 0, skipped: 0, errors: 0, duration: Date.now() - start };
        }
        const changedGiataIds = new Set(changedItems.map((i) => i.giataId));
        console.log(`[GIATA] Incremental sync: ${changedGiataIds.size} changed items found`);
        // Create job
        const job = await giata_repository_1.default.createSyncJob(JOB_TYPE, changedGiataIds.size);
        let synced = 0;
        let errors = 0;
        let skipped = 0;
        let processed = 0;
        let offset = 0;
        const batchSize = 200;
        try {
            while (true) {
                const hotels = await giata_repository_1.default.getHotelsWithGiataCode({ limit: batchSize, offset });
                if (hotels.length === 0)
                    break;
                const toSync = hotels.filter((h) => changedGiataIds.has(h.giataCode));
                for (let i = 0; i < toSync.length; i += CONCURRENT_HOTELS) {
                    const chunk = toSync.slice(i, Math.min(i + CONCURRENT_HOTELS, toSync.length));
                    const results = await Promise.allSettled(chunk.map((h) => this.syncHotel(h.hotelCode, h.giataCode)));
                    for (const r of results) {
                        if (r.status === 'fulfilled' && r.value)
                            synced++;
                        else
                            errors++;
                    }
                    processed += chunk.length;
                    await giata_repository_1.default.updateSyncJob(job.id, {
                        processedRecords: processed,
                        lastProcessedKey: chunk[chunk.length - 1].hotelCode,
                    });
                }
                skipped += hotels.length - toSync.length;
                offset += batchSize;
            }
            const duration = Date.now() - start;
            await giata_repository_1.default.updateSyncJob(job.id, {
                status: 'COMPLETED',
                completedAt: new Date(),
                processedRecords: processed,
            });
            console.log(`[GIATA] Incremental sync COMPLETED: ${synced} synced, ${skipped} skipped, ${errors} errors`);
            logger_1.default.info({ synced, skipped, errors, durationMs: duration }, 'GIATA incremental sync: completed');
            await (0, audit_1.logAuditEvent)({
                action: 'giata_incremental_sync',
                entity: 'hotel',
                details: { since: sinceStr, changed: changedGiataIds.size, synced, skipped, errors, durationMs: duration },
            });
            return { total: changedGiataIds.size, synced, skipped, errors, duration };
        }
        catch (err) {
            await giata_repository_1.default.updateSyncJob(job.id, {
                status: 'FAILED',
                errorMessage: err.message,
                completedAt: new Date(),
            });
            console.log(`[GIATA] Incremental sync FAILED: ${err.message}`);
            logger_1.default.error({ err: err.message }, 'GIATA incremental sync: failed');
            throw err;
        }
    }
    // ─── Resolve Missing GIATA Codes ────────────────────────────────────
    /**
     * For hotels without a giataCode but with a supplierCode,
     * try resolving via GIATA Multicodes GDS lookup.
     */
    async resolveMissingGiataCodes() {
        logger_1.default.info('GIATA resolve: starting missing code resolution');
        const hotels = await giata_repository_1.default.getHotelsWithoutGiataCode({ limit: 500 });
        let resolved = 0;
        let skipped = 0;
        for (const hotel of hotels) {
            if (!hotel.supplierCode) {
                skipped++;
                continue;
            }
            const giataId = await giata_client_service_1.default.resolveByGds(hotel.supplierCode, hotel.hotelCode);
            if (giataId) {
                await giata_repository_1.default.updateGiataStatus(hotel.hotelCode, 'resolved', giataId);
                // Queue a full sync for this newly resolved hotel
                this.syncHotel(hotel.hotelCode, giataId).catch((err) => logger_1.default.warn({ err: err.message, hotelCode: hotel.hotelCode }, 'GIATA: auto-sync after resolve failed'));
                resolved++;
                logger_1.default.info({ hotelCode: hotel.hotelCode, giataId }, 'GIATA resolve: found GIATA ID');
            }
            else {
                await giata_repository_1.default.updateGiataStatus(hotel.hotelCode, 'not_found');
                skipped++;
            }
        }
        logger_1.default.info({ resolved, skipped }, 'GIATA resolve: completed');
        await (0, audit_1.logAuditEvent)({
            action: 'giata_resolve_missing',
            entity: 'hotel',
            details: { resolved, skipped },
        });
        return { resolved, skipped };
    }
    // ─── Handle Moved Properties ────────────────────────────────────────
    /**
     * Check for properties that were moved/merged in GIATA and update our giataCode.
     */
    async handleMovedProperties(since) {
        const sinceStr = since ? since.toISOString().split('T')[0] : undefined;
        const moved = await giata_client_service_1.default.getMovedProperties(sinceStr);
        let updated = 0;
        for (const m of moved) {
            // Check if we have a hotel with the old GIATA ID
            const hotels = await giata_repository_1.default.getHotelsWithGiataCode({ limit: 1000 });
            const match = hotels.find((h) => h.giataCode === m.oldGiataId);
            if (match) {
                await giata_repository_1.default.updateGiataStatus(match.hotelCode, 'moved', m.newGiataId);
                logger_1.default.info({
                    hotelCode: match.hotelCode,
                    oldGiataId: m.oldGiataId,
                    newGiataId: m.newGiataId,
                }, 'GIATA: updated moved property');
                await (0, audit_1.logAuditEvent)({
                    action: 'giata_property_moved',
                    entity: 'hotel',
                    entityId: match.hotelCode,
                    details: { oldGiataId: m.oldGiataId, newGiataId: m.newGiataId, movedOn: m.movedOn },
                });
                // Re-sync with new ID
                this.syncHotel(match.hotelCode, m.newGiataId).catch((err) => logger_1.default.warn({ err: err.message, hotelCode: match.hotelCode }, 'GIATA: re-sync after move failed'));
                updated++;
            }
        }
        return updated;
    }
    // ─── Admin Status ───────────────────────────────────────────────────
    /** Get sync status overview for admin dashboard. */
    async getStatus() {
        const [statusCounts, latestFull, latestIncremental] = await Promise.all([
            giata_repository_1.default.getGiataStatusCounts(),
            giata_repository_1.default.getLatestJob('GIATA_FULL_SYNC'),
            giata_repository_1.default.getLatestJob('GIATA_INCREMENTAL_SYNC'),
        ]);
        return {
            isConfigured: giata_client_service_1.default.isConfigured(),
            statusCounts,
            latestFullSync: latestFull ? {
                id: latestFull.id,
                status: latestFull.status,
                totalRecords: latestFull.totalRecords,
                processedRecords: latestFull.processedRecords,
                lastProcessedKey: latestFull.lastProcessedKey,
                startedAt: latestFull.startedAt,
                completedAt: latestFull.completedAt,
                errorMessage: latestFull.errorMessage,
            } : null,
            latestIncrementalSync: latestIncremental ? {
                id: latestIncremental.id,
                status: latestIncremental.status,
                totalRecords: latestIncremental.totalRecords,
                processedRecords: latestIncremental.processedRecords,
                startedAt: latestIncremental.startedAt,
                completedAt: latestIncremental.completedAt,
                errorMessage: latestIncremental.errorMessage,
            } : null,
        };
    }
}
exports.default = new GiataSyncService();

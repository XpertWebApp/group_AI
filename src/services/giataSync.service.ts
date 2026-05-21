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

import giataClient from './giata.client.service';
import giataRepository from '../repositories/giata.repository';
import { logAuditEvent } from '../utils/audit';
import logger from '../utils/logger';

const SYNC_LANGUAGES = ['en', 'de'];
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const CONCURRENT_HOTELS = 3;

interface SyncResult {
    total: number;
    synced: number;
    skipped: number;
    errors: number;
    duration: number;
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T | null> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            if (attempt === retries) return null;
            logger.warn({ attempt, err: err.message }, 'GIATA sync: retrying after failure');
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
    async syncHotel(hotelCode: string, giataId: string): Promise<boolean> {
        console.log(`[GIATA] Syncing hotel ${hotelCode} (giataId: ${giataId})`);
        logger.info({ hotelCode, giataId }, 'GIATA sync: starting single hotel');

        try {
            // 1. Texts (EN + DE)
            for (const lang of SYNC_LANGUAGES) {
                const textResult = await withRetry(() => giataClient.getTexts(lang, giataId));
                if (textResult && textResult.sections.length > 0) {
                    await giataRepository.upsertTexts(
                        hotelCode,
                        giataId,
                        textResult.sections.map((s) => ({
                            lang,
                            sectionType: s.sectionType,
                            title: s.title,
                            content: s.content,
                            lastUpdate: textResult.lastUpdate,
                        })),
                    );
                    console.log(`[GIATA]   Texts (${lang}): ${textResult.sections.length} sections stored`);
                } else {
                    console.log(`[GIATA]   Texts (${lang}): not available (404 not in catalog OR 403 account entitlement — see warn logs)`);
                }
            }

            // 2. Images
            const imageResult = await withRetry(() => giataClient.getImages(giataId));
            if (imageResult && imageResult.images.length > 0) {
                let order = 0;
                const imageRows = imageResult.images.map((img) => {
                    const small    = img.sizes.find((s) => s.maxwidth === '74');
                    const medium   = img.sizes.find((s) => s.maxwidth === '320');
                    const large    = img.sizes.find((s) => s.maxwidth === '800');
                    const fullHd   = img.sizes.find((s) => s.maxwidth === '1920');
                    const original = img.sizes.find((s) => s.maxwidth === '3840');
                    return {
                        imageType: img.type,
                        displayOrder: order++,
                        urlSmall: small?.url,
                        urlMedium: medium?.url,
                        urlLarge: large?.url,
                        urlFullHd: fullHd?.url,
                        urlOriginal: original?.url,
                        lastUpdate: img.lastUpdate,
                    };
                });
                await giataRepository.upsertImages(hotelCode, giataId, imageRows);
                console.log(`[GIATA]   Images: ${imageRows.length} stored`);
            } else {
                console.log(`[GIATA]   Images: not available`);
            }

            // 3. Fact sheet
            const factResult = await withRetry(() => giataClient.getFactSheet(giataId));
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
                await giataRepository.upsertFacts(hotelCode, giataId, factRows);
                console.log(`[GIATA]   Facts: ${factRows.length} stored`);
            } else {
                console.log(`[GIATA]   Facts: not available`);
            }

            // 4. Multicodes mappings
            const propertyResult = await withRetry(() => giataClient.getPropertyDetails(giataId));
            if (propertyResult && propertyResult.providers.length > 0) {
                const mappingRows = propertyResult.providers.map((p) => ({
                    providerCode: p.providerCode,
                    providerType: p.providerType,
                    codeValue: p.codeValues.join('|'),
                }));
                await giataRepository.upsertMappings(hotelCode, giataId, mappingRows);
                console.log(`[GIATA]   Mappings: ${mappingRows.length} providers stored`);
            } else {
                console.log(`[GIATA]   Mappings: not available`);
            }

            // 5. Mark hotel as synced
            await giataRepository.updateGiataStatus(hotelCode, 'synced');

            console.log(`[GIATA] ✓ Hotel ${hotelCode} synced successfully`);
            logger.info({ hotelCode, giataId }, 'GIATA sync: hotel completed');
            return true;
        } catch (err: any) {
            console.log(`[GIATA] ✗ Hotel ${hotelCode} FAILED: ${err.message}`);
            logger.error({ err: err.message, hotelCode, giataId }, 'GIATA sync: hotel failed');
            await giataRepository.updateGiataStatus(hotelCode, 'error');
            return false;
        }
    }

    // ─── Full Sync (with SyncJob resume) ───────────────────────────────

    /**
     * Full sync: iterate all hotels in master DB that have a giataCode.
     * Uses SyncJob for progress tracking and resume-on-interrupt.
     */
    async fullSync(): Promise<SyncResult> {
        const start = Date.now();
        const JOB_TYPE = 'GIATA_FULL_SYNC';

        // 1. Check for in-progress job (resume) or create new one
        let job = await giataRepository.getInProgressJob(JOB_TYPE);
        if (!job) {
            const totalRecords = await giataRepository.countHotelsWithGiataCode();
            job = await giataRepository.createSyncJob(JOB_TYPE, totalRecords);
            console.log(`[GIATA] Full sync: starting new job ${job.id} (${totalRecords} hotels)`);
            logger.info({ jobId: job.id, totalRecords }, 'GIATA full sync: starting new job');
        } else {
            console.log(`[GIATA] Full sync: RESUMING job ${job.id} from key "${job.lastProcessedKey}" (${job.processedRecords} already done)`);
            logger.info({ jobId: job.id, lastKey: job.lastProcessedKey, processed: job.processedRecords }, 'GIATA full sync: resuming');
        }

        let synced = 0;
        let skipped = 0;
        let errors = 0;
        let processed = job.processedRecords ?? 0;
        const batchSize = 100;

        try {
            // 2. Fetch hotels with giataCode using a keyset cursor on hotelCode.
            //    On resume we pick up STRICTLY AFTER the last hotel we acknowledged
            //    via lastProcessedKey — so every batch in the loop is fresh work,
            //    not a re-run of already-synced hotels.
            //    Hotels are returned ordered by hotelCode ASC; lastProcessedKey
            //    advances monotonically as we process chunks.
            let cursor: string | undefined = job.lastProcessedKey ?? undefined;
            if (cursor) {
                console.log(`[GIATA] Resume: skipping all hotels with hotelCode <= "${cursor}"`);
            }

            while (true) {
                const hotels = await giataRepository.getHotelsWithGiataCode({
                    limit: batchSize,
                    afterHotelCode: cursor,
                });
                if (hotels.length === 0) break;

                // 3. Process this batch in concurrency-limited chunks.
                for (let i = 0; i < hotels.length; i += CONCURRENT_HOTELS) {
                    const chunk = hotels.slice(i, Math.min(i + CONCURRENT_HOTELS, hotels.length));
                    const results = await Promise.allSettled(
                        chunk.map((h) => this.syncHotel(h.hotelCode, h.giataCode!)),
                    );

                    for (const r of results) {
                        if (r.status === 'fulfilled' && r.value) synced++;
                        else errors++;
                    }

                    processed += chunk.length;
                    const lastKey = chunk[chunk.length - 1].hotelCode;
                    // Advance cursor so the next outer-loop iteration starts here.
                    cursor = lastKey;

                    // 4. Persist progress after each chunk (resume point).
                    await giataRepository.updateSyncJob(job.id, {
                        processedRecords: processed,
                        lastProcessedKey: lastKey,
                    });
                }

                console.log(`[GIATA] Full sync progress: ${processed} processed, ${synced} synced, ${errors} errors`);
            }

            // 6. Handle moved properties
            try {
                const moved = await this.handleMovedProperties();
                console.log(`[GIATA] Moved properties handled: ${moved}`);
            } catch (err: any) {
                logger.warn({ err: err.message }, 'GIATA full sync: failed to handle moved properties');
            }

            // 7. Mark job as completed
            const duration = Date.now() - start;
            await giataRepository.updateSyncJob(job.id, {
                status: 'COMPLETED',
                completedAt: new Date(),
                processedRecords: processed,
            });

            console.log(`[GIATA] Full sync COMPLETED: ${synced} synced, ${errors} errors, ${Math.floor(duration / 1000)}s`);
            logger.info({ synced, skipped, errors, durationMs: duration }, 'GIATA full sync: completed');

            await logAuditEvent({
                action: 'giata_full_sync',
                entity: 'hotel',
                details: { total: processed, synced, skipped, errors, durationMs: duration },
            });

            return { total: processed, synced, skipped, errors, duration };
        } catch (err: any) {
            // Mark job as failed (but keep lastProcessedKey for resume)
            await giataRepository.updateSyncJob(job.id, {
                status: 'FAILED',
                errorMessage: err.message,
                completedAt: new Date(),
            });
            console.log(`[GIATA] Full sync FAILED at ${processed} records: ${err.message}`);
            logger.error({ err: err.message, processed }, 'GIATA full sync: failed');
            throw err;
        }
    }

    // ─── Incremental Sync (with SyncJob tracking) ───────────────────────

    /**
     * Incremental sync: fetch hotels changed since a given date from GIATA,
     * cross-reference with our DB, and re-sync only the matched hotels.
     * Uses SyncJob for progress tracking.
     */
    async incrementalSync(since?: Date): Promise<SyncResult> {
        const start = Date.now();
        const JOB_TYPE = 'GIATA_INCREMENTAL_SYNC';
        const sinceDate = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
        const sinceStr = sinceDate.toISOString().split('T')[0];

        console.log(`[GIATA] Incremental sync: checking changes since ${sinceStr}`);
        logger.info({ since: sinceStr }, 'GIATA incremental sync: starting');

        // Get changed GIATA IDs from MHG
        const changedItems = await giataClient.getItemsChangedSince(sinceStr);
        if (changedItems.length === 0) {
            console.log('[GIATA] Incremental sync: no changes found');
            return { total: 0, synced: 0, skipped: 0, errors: 0, duration: Date.now() - start };
        }

        const changedGiataIds = new Set(changedItems.map((i) => i.giataId));
        console.log(`[GIATA] Incremental sync: ${changedGiataIds.size} changed items found`);

        // Create job
        const job = await giataRepository.createSyncJob(JOB_TYPE, changedGiataIds.size);

        let synced = 0;
        let errors = 0;
        let skipped = 0;
        let processed = 0;
        let offset = 0;
        const batchSize = 200;

        try {
            while (true) {
                const hotels = await giataRepository.getHotelsWithGiataCode({ limit: batchSize, offset });
                if (hotels.length === 0) break;

                const toSync = hotels.filter((h) => changedGiataIds.has(h.giataCode!));

                for (let i = 0; i < toSync.length; i += CONCURRENT_HOTELS) {
                    const chunk = toSync.slice(i, Math.min(i + CONCURRENT_HOTELS, toSync.length));
                    const results = await Promise.allSettled(
                        chunk.map((h) => this.syncHotel(h.hotelCode, h.giataCode!)),
                    );

                    for (const r of results) {
                        if (r.status === 'fulfilled' && r.value) synced++;
                        else errors++;
                    }

                    processed += chunk.length;
                    await giataRepository.updateSyncJob(job.id, {
                        processedRecords: processed,
                        lastProcessedKey: chunk[chunk.length - 1].hotelCode,
                    });
                }

                skipped += hotels.length - toSync.length;
                offset += batchSize;
            }

            const duration = Date.now() - start;
            await giataRepository.updateSyncJob(job.id, {
                status: 'COMPLETED',
                completedAt: new Date(),
                processedRecords: processed,
            });

            console.log(`[GIATA] Incremental sync COMPLETED: ${synced} synced, ${skipped} skipped, ${errors} errors`);
            logger.info({ synced, skipped, errors, durationMs: duration }, 'GIATA incremental sync: completed');

            await logAuditEvent({
                action: 'giata_incremental_sync',
                entity: 'hotel',
                details: { since: sinceStr, changed: changedGiataIds.size, synced, skipped, errors, durationMs: duration },
            });

            return { total: changedGiataIds.size, synced, skipped, errors, duration };
        } catch (err: any) {
            await giataRepository.updateSyncJob(job.id, {
                status: 'FAILED',
                errorMessage: err.message,
                completedAt: new Date(),
            });
            console.log(`[GIATA] Incremental sync FAILED: ${err.message}`);
            logger.error({ err: err.message }, 'GIATA incremental sync: failed');
            throw err;
        }
    }

    // ─── Resolve Missing GIATA Codes ────────────────────────────────────

    /**
     * For hotels without a giataCode but with a supplierCode,
     * try resolving via GIATA Multicodes GDS lookup.
     */
    async resolveMissingGiataCodes(): Promise<{ resolved: number; skipped: number }> {
        logger.info('GIATA resolve: starting missing code resolution');

        const hotels = await giataRepository.getHotelsWithoutGiataCode({ limit: 500 });
        let resolved = 0;
        let skipped = 0;

        for (const hotel of hotels) {
            if (!hotel.supplierCode) { skipped++; continue; }

            const giataId = await giataClient.resolveByGds(hotel.supplierCode, hotel.hotelCode);
            if (giataId) {
                await giataRepository.updateGiataStatus(hotel.hotelCode, 'resolved', giataId);
                // Queue a full sync for this newly resolved hotel
                this.syncHotel(hotel.hotelCode, giataId).catch((err) =>
                    logger.warn({ err: err.message, hotelCode: hotel.hotelCode }, 'GIATA: auto-sync after resolve failed'),
                );
                resolved++;
                logger.info({ hotelCode: hotel.hotelCode, giataId }, 'GIATA resolve: found GIATA ID');
            } else {
                await giataRepository.updateGiataStatus(hotel.hotelCode, 'not_found');
                skipped++;
            }
        }

        logger.info({ resolved, skipped }, 'GIATA resolve: completed');

        await logAuditEvent({
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
    async handleMovedProperties(since?: Date): Promise<number> {
        const sinceStr = since ? since.toISOString().split('T')[0] : undefined;
        const moved = await giataClient.getMovedProperties(sinceStr);

        let updated = 0;
        for (const m of moved) {
            // Check if we have a hotel with the old GIATA ID
            const hotels = await giataRepository.getHotelsWithGiataCode({ limit: 1000 });
            const match = hotels.find((h) => h.giataCode === m.oldGiataId);
            if (match) {
                await giataRepository.updateGiataStatus(match.hotelCode, 'moved', m.newGiataId);
                logger.info({
                    hotelCode: match.hotelCode,
                    oldGiataId: m.oldGiataId,
                    newGiataId: m.newGiataId,
                }, 'GIATA: updated moved property');

                await logAuditEvent({
                    action: 'giata_property_moved',
                    entity: 'hotel',
                    entityId: match.hotelCode,
                    details: { oldGiataId: m.oldGiataId, newGiataId: m.newGiataId, movedOn: m.movedOn },
                });

                // Re-sync with new ID
                this.syncHotel(match.hotelCode, m.newGiataId).catch((err) =>
                    logger.warn({ err: err.message, hotelCode: match.hotelCode }, 'GIATA: re-sync after move failed'),
                );
                updated++;
            }
        }

        return updated;
    }

    // ─── Admin Status ───────────────────────────────────────────────────

    /** Get sync status overview for admin dashboard. */
    async getStatus(): Promise<{
        isConfigured: boolean;
        statusCounts: Record<string, number>;
        latestFullSync: any;
        latestIncrementalSync: any;
    }> {
        const [statusCounts, latestFull, latestIncremental] = await Promise.all([
            giataRepository.getGiataStatusCounts(),
            giataRepository.getLatestJob('GIATA_FULL_SYNC'),
            giataRepository.getLatestJob('GIATA_INCREMENTAL_SYNC'),
        ]);
        return {
            isConfigured: giataClient.isConfigured(),
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

export default new GiataSyncService();

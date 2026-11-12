import staticDataRepository from '../repositories/staticData.repository';
import logger from '../utils/logger';
import { JobStatus } from '@prisma/client';
import pLimit from 'p-limit';
import wbeClientService from './wbe.client.service';
import giataSyncService from './giataSync.service';
import { NATIONALITIES } from '../data/nationalities';
import { normaliseCountryCode } from '../utils/countryCode';

/**
 * Hotel details sync stops when more than this share of recent hotels fail.
 * A run that fails broadly (bad data, WBE down, schema mismatch) otherwise keeps
 * going for hours, filling the database log with one error per hotel.
 */
const DETAILS_MAX_FAILURE_RATE = Number(process.env['HOTEL_DETAILS_MAX_FAILURE_RATE'] ?? 0.05);
/** Failure rate is judged over this many most recent hotels... */
const DETAILS_FAILURE_WINDOW = 500;
/** ...and only once at least this many have been attempted, so a few early errors do not stop the run. */
const DETAILS_FAILURE_MIN_SAMPLE = 200;

export class StaticDataService {
    constructor() {
        this.syncDestinations = this.syncDestinations.bind(this);
        this.syncLanguages = this.syncLanguages.bind(this);
        this.syncCurrencies = this.syncCurrencies.bind(this);
        this.syncNationalities = this.syncNationalities.bind(this);
        this.syncHotelsList = this.syncHotelsList.bind(this);
        this.syncHotelDetails = this.syncHotelDetails.bind(this);
        this.fullSync = this.fullSync.bind(this);
    }

    private async syncDestinationRecursive(
        dest: any,
        parentId: number | null,
        countryContext?: { countryId?: number; countryIso?: string; countryName?: string }
    ) {
        const destId = dest.DestinationId || dest.id || dest.Id;
        const destName = dest.Name || dest.name || `Destination ${destId}`;

        if (destId === undefined) {
            console.log('Skipping recursive destination with undefined ID:', JSON.stringify(dest));
            return;
        }

        if (!dest.Name && !dest.name) {
            logger.warn({ msg: 'Destination missing name, using fallback', destId, dest });
        }

        await staticDataRepository.upsertDestination({
            id: destId,
            name: destName,
            parentId: parentId,
            lastSyncedAt: new Date(),
            countryCode: countryContext?.countryIso || undefined,
            metadata: countryContext
                ? {
                      countryId: countryContext.countryId,
                      countryName: countryContext.countryName,
                      countryIso: countryContext.countryIso,
                  }
                : undefined,
        });

        if (dest.Children && Array.isArray(dest.Children) && dest.Children.length > 0) {
            for (const child of dest.Children) {
                await this.syncDestinationRecursive(child, destId, countryContext);
            }
        }
    }

    async syncDestinations() {
        console.log('--- syncDestinations() called ---');
        logger.info('Starting destination sync with resume support...');

        const type = 'DESTINATIONS';

        // 1. Check for resume
        let job = await staticDataRepository.getInProgressJob(type);
        if (!job) {
            job = await staticDataRepository.createJob({
                type,
                status: JobStatus.IN_PROGRESS,
            });
            logger.info({ msg: 'Started new DESTINATIONS sync job', jobId: job.id });
        } else {
            logger.info({ msg: 'Resuming DESTINATIONS sync job', jobId: job.id, lastKey: job.lastProcessedKey });
        }

        try {
            const countries = await wbeClientService.getDestinations();
            const totalRecords = countries.length;
            await staticDataRepository.updateJob(job.id, { totalRecords });

            console.log(`Fetched ${countries.length} country/destination groups.`);

            // 2. Resume from last key if exists
            let startIndex = 0;
            if (job.lastProcessedKey) {
                const lastIndex = countries.findIndex((country: any) => {
                    const countryId = country.CountryId ?? country.countryId ?? country.Id ?? country.id;
                    const iso = country.ISO ?? country.iso;
                    const keyCandidate = (countryId ?? iso ?? '').toString();
                    return keyCandidate === job.lastProcessedKey;
                });
                if (lastIndex !== -1) {
                    startIndex = lastIndex + 1;
                    logger.info(`Resuming destinations from index ${startIndex} after key ${job.lastProcessedKey}`);
                }
            }

            for (let i = startIndex; i < countries.length; i++) {
                const country = countries[i];
                const countryContext = {
                    countryId: country.CountryId ?? country.countryId,
                    countryIso: country.ISO ?? country.iso,
                    countryName: country.Name ?? country.name,
                };

                if (country.Destinations && Array.isArray(country.Destinations)) {
                    for (const dest of country.Destinations) {
                        await this.syncDestinationRecursive(dest, null, countryContext);
                    }
                } else {
                    // Handle cases where the top level might be a destination directly
                    const destId = country.DestinationId || country.id || country.Id;
                    if (destId) {
                        await this.syncDestinationRecursive(country, null, countryContext);
                    }
                }

                const processedCount = i + 1;
                const countryIdForKey = country.CountryId ?? country.countryId ?? country.Id ?? country.id;
                const isoForKey = country.ISO ?? country.iso;
                const lastKey = (countryIdForKey ?? isoForKey ?? '').toString();

                await staticDataRepository.updateJob(job.id, {
                    processedRecords: processedCount,
                    lastProcessedKey: lastKey,
                });
            }

            await staticDataRepository.updateJob(job.id, {
                status: JobStatus.COMPLETED,
                completedAt: new Date(),
            });

            logger.info(`Synced destinations from ${countries.length} groups (resume-aware)`);
        } catch (error: any) {
            await staticDataRepository.updateJob(job.id, {
                status: JobStatus.FAILED,
                errorMessage: error.message,
                completedAt: new Date(),
            });
            logger.error({ msg: 'DESTINATIONS sync failed', jobId: job.id, error: error.message });
            throw error;
        }
    }

    async syncLanguages() {
        logger.info('Starting languages sync...');
        const resp = await wbeClientService.getLanguages();
        const data = resp?.Data ?? resp?.data ?? resp;
        if (!Array.isArray(data)) {
            logger.warn({ msg: 'Languages response is not an array', sample: data });
            return;
        }
        for (const lang of data) {
            const code = lang.Code ?? lang.code;
            const name = lang.Name ?? lang.name ?? null;
            if (!code) continue;
            await staticDataRepository.upsertLanguage({ code: String(code), name: name ? String(name) : null });
        }
        logger.info(`Synced ${data.length} languages`);
    }

    async syncCurrencies() {
        logger.info('Starting currencies sync...');
        const resp = await wbeClientService.getCurrencies();
        const data = resp?.Data ?? resp?.data ?? resp;
        if (!Array.isArray(data)) {
            logger.warn({ msg: 'Currencies response is not an array', sample: data });
            return;
        }
        for (const cur of data) {
            const code = cur.Code ?? cur.code;
            const name = cur.Name ?? cur.name ?? null;
            if (!code) continue;
            await staticDataRepository.upsertCurrency({ code: String(code), name: name ? String(name) : null });
        }
        logger.info(`Synced ${data.length} currencies`);
    }

    async syncNationalities() {
        // The documented WBE endpoint `[WebAPI_URL]/api/hotel/nationalities`
        // returns 404 on every WBE host we have access to (UAT static, UAT
        // search, prod B2B — verified 2026-06-26). Until WBE confirms the
        // correct WebAPI host, we seed from a static copy of the Hub portal's
        // nationality list — same demonyms WBE itself uses (see the doc
        // example `Code: "AF" / Name: "Afghan"`).
        //
        // To swap back to the live API once WBE provides the host:
        //   1. Set WBE_WEBAPI_URL in env and read it in wbe.client.service.
        //   2. Restore the previous body (commented below) that calls
        //      wbeClientService.getNationalities() and iterates resp.Data.
        // The upsert is keyed on `code`, so flipping back is non-destructive.
        logger.info(`Seeding ${NATIONALITIES.length} nationalities from static list (Hub-sourced)`);
        for (const nat of NATIONALITIES) {
            await staticDataRepository.upsertNationality({ code: nat.code, name: nat.name });
        }
        logger.info(`Seeded ${NATIONALITIES.length} nationalities`);
    }

    async syncHotelsList() {
        logger.info('Starting hotels list sync...');
        const type = 'HOTELS_LIST';

        // 1. Check for resume
        let job = await staticDataRepository.getInProgressJob(type);
        if (!job) {
            job = await staticDataRepository.createJob({
                type,
                status: JobStatus.IN_PROGRESS,
            });
            logger.info({ msg: 'Started new HOTELS_LIST sync job', jobId: job.id });
        } else {
            logger.info({ msg: 'Resuming HOTELS_LIST sync job', jobId: job.id, lastKey: job.lastProcessedKey });
        }

        try {
            const hotels = await wbeClientService.getHotels();
            const totalRecords = hotels.length;
            await staticDataRepository.updateJob(job.id, { totalRecords });

            logger.info(`Fetched ${totalRecords} hotels in summary list.`);

            // 2. Fetch existing hotelCodes for smart update/create
            const existingHotelCodes = await staticDataRepository.getAllHotelCodes();

            const chunkSize = 1000;
            const startTime = Date.now();

            // 3. Resume from last key if exists
            let startIndex = 0;
            if (job.lastProcessedKey) {
                const lastIndex = hotels.findIndex((h: any) => (h.HotelCode || h.hotelCode) === job.lastProcessedKey);
                if (lastIndex !== -1) {
                    startIndex = lastIndex + 1;
                    logger.info(`Resuming from index ${startIndex} after hotelCode ${job.lastProcessedKey}`);
                }
            }

            for (let i = startIndex; i < totalRecords; i += chunkSize) {
                const chunk = hotels.slice(i, i + chunkSize);
                const toCreate: any[] = [];
                const toUpdate: any[] = [];

                for (const h of chunk) {
                    const hotelCode = h.HotelCode || h.hotelCode;
                    if (!hotelCode) continue;

                    const hotelData = {
                        hotelCode,
                        name: h.Name || h.name,
                        masterHotelId: h.MasterHotelId || h.id || h.id_master,
                        hotelDetailsUrl: h.HotelDetailsUrl || h.detailsUrl,
                        destinationId: h.DestinationId || h.destination_id,
                        starRating: h.StarRating || h.stars,
                        // TotalRooms / NumberOfRooms — used for Step 3.2 inventory overlap check
                        totalRooms: h.TotalRooms ?? h.totalRooms ?? h.NumberOfRooms ?? h.numberOfRooms ?? null,
                        category: h.Category || h.category,
                        propertyType: h.PropertyType ?? h.propertyType ?? null,
                        giataCode: h.GiataId ? String(h.GiataId) : h.giata ? String(h.giata) : null,
                        lastSyncedAt: new Date(),
                    };

                    if (existingHotelCodes.has(hotelCode)) {
                        toUpdate.push(hotelData);
                    } else {
                        toCreate.push(hotelData);
                    }
                }

                // Batch Create
                if (toCreate.length > 0) {
                    await staticDataRepository.createManyHotels(toCreate);

                    // Auto-queue GIATA sync for newly created hotels with a giataCode
                    for (const h of toCreate) {
                        if (h.giataCode) {
                            giataSyncService.syncHotel(h.hotelCode, h.giataCode).catch((err) =>
                                logger.warn({ err: err.message, hotelCode: h.hotelCode }, 'Auto GIATA sync after WBE create failed'),
                            );
                        }
                    }
                }

                // Sequential Update for existing (Prisma doesn't have updateMany by unique key yet)
                // We do it in chunks to avoid overloading
                if (toUpdate.length > 0) {
                    await Promise.all(toUpdate.map(h => staticDataRepository.updateHotel(h.hotelCode, h)));
                }

                const processedCount = i + chunk.length;
                const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
                const lastKey = chunk[chunk.length - 1].HotelCode || chunk[chunk.length - 1].hotelCode;

                // Update Job Progress
                await staticDataRepository.updateJob(job.id, {
                    processedRecords: processedCount,
                    lastProcessedKey: lastKey,
                });

                logger.info({
                    msg: `Batch completed`,
                    batch: `${Math.ceil(processedCount / chunkSize)}/${Math.ceil(totalRecords / chunkSize)}`,
                    processed: `${processedCount}/${totalRecords}`,
                    elapsed: `${elapsedSeconds}s`,
                    jobId: job.id
                });
            }

            // Mark job as completed
            await staticDataRepository.updateJob(job.id, {
                status: JobStatus.COMPLETED,
                completedAt: new Date(),
            });

            logger.info(`Synced ${totalRecords} hotels (light) - Total time: ${Math.floor((Date.now() - startTime) / 1000)}s`);
        } catch (error: any) {
            await staticDataRepository.updateJob(job.id, {
                status: JobStatus.FAILED,
                errorMessage: error.message,
                completedAt: new Date(),
            });
            logger.error({ msg: 'HOTELS_LIST sync failed', jobId: job.id, error: error.message });
            throw error;
        }
    }

    async syncHotelDetails() {
        logger.info('Starting hotel details sync...');
        const type = 'HOTEL_DETAILS';

        // 1. Check for resume
        let job = await staticDataRepository.getInProgressJob(type);
        if (!job) {
            job = await staticDataRepository.createJob({
                type,
                status: JobStatus.IN_PROGRESS,
            });
            logger.info({ msg: 'Started new HOTEL_DETAILS sync job', jobId: job.id });
        } else {
            logger.info({ msg: 'Resuming HOTEL_DETAILS sync job', jobId: job.id, lastKey: job.lastProcessedKey });
        }

        try {
            const hotels = await staticDataRepository.getHotelsNeedingDetails();
            const totalRecords = hotels.length;
            await staticDataRepository.updateJob(job.id, { totalRecords });

            logger.info(`Found ${totalRecords} hotels needing details update`);

            // 2. Resume from last key if exists
            let startIndex = 0;
            if (job.lastProcessedKey) {
                const lastIndex = hotels.findIndex((h: any) => h.hotelCode === job.lastProcessedKey);
                if (lastIndex !== -1) {
                    startIndex = lastIndex + 1;
                    logger.info(`Resuming from index ${startIndex} after hotelCode ${job.lastProcessedKey}`);
                }
            }

            const hotelsToProcess = hotels.slice(startIndex);
            const limit = pLimit(3); // Reduced concurrency (Fix 3)
            const startTime = Date.now();
            let processedInCurrentRun = 0;
            let consecutive403 = 0; // 403 Stop Mechanism (Fix 2)

            // address_country must be an ISO code (varchar 10); the hotel's
            // destination carries one, so load them once for the whole run.
            const destinationCountries = await staticDataRepository.getDestinationCountryCodes();

            // Failure-rate guard: once set, every queued hotel is skipped and
            // the job is marked FAILED after the in-flight ones finish.
            let abortReason: string | null = null;
            const recentOutcomes: boolean[] = []; // true = failed
            let recentFailures = 0;
            let attempted = 0;
            let failedTotal = 0;

            const recordOutcome = (failed: boolean) => {
                attempted++;
                if (failed) failedTotal++;
                recentOutcomes.push(failed);
                if (failed) recentFailures++;
                if (recentOutcomes.length > DETAILS_FAILURE_WINDOW) {
                    if (recentOutcomes.shift()) recentFailures--;
                }

                if (
                    !abortReason &&
                    recentOutcomes.length >= DETAILS_FAILURE_MIN_SAMPLE &&
                    recentFailures / recentOutcomes.length > DETAILS_MAX_FAILURE_RATE
                ) {
                    const rate = ((recentFailures / recentOutcomes.length) * 100).toFixed(1);
                    abortReason =
                        `Hotel details sync stopped: ${recentFailures} of the last ${recentOutcomes.length} hotels failed ` +
                        `(${rate}%, limit ${(DETAILS_MAX_FAILURE_RATE * 100).toFixed(1)}%). ` +
                        `${failedTotal} failed of ${attempted} attempted in this run.`;
                    logger.error({ msg: abortReason, jobId: job.id });
                }
            };

            const processHotel = async (h: any, index: number) => {
                if (abortReason) return;
                if (!h.hotelDetailsUrl) return;

                try {
                    const details = await wbeClientService.getHotelDetails(h.hotelDetailsUrl);
                    consecutive403 = 0; // Reset on success

                    // Update hotel with detailed fields
                    // TotalRooms from HotelDetailsV4 is used for Step 3.2 inventory overlap check.
                    const totalRoomsFromDetails =
                        details.TotalRooms ?? details.totalRooms ??
                        details.NumberOfRooms ?? details.numberOfRooms ??
                        null;

                    await staticDataRepository.updateHotel(h.hotelCode, {
                        name: details.Name || details.name,
                        address: details.Address || details.address,
                        addressCity: details.AddressCity || details.addressCity,
                        addressCountry: normaliseCountryCode(
                            details.AddressCountry ?? details.addressCountry,
                            h.destinationId != null ? destinationCountries.get(h.destinationId) : null,
                        ),
                        latitude: details.Latitude || details.latitude,
                        longitude: details.Longitude || details.longitude,
                        ...(totalRoomsFromDetails !== null && { totalRooms: totalRoomsFromDetails }),
                        metadata: details,
                        detailsFetchedAt: new Date(),
                        lastSyncedAt: new Date(),
                    });

                    // Sync images (Fix: handle strings and objects)
                    if (details.Images && Array.isArray(details.Images)) {
                        for (let i = 0; i < details.Images.length; i++) {
                            const img = details.Images[i];
                            let imageKey: string | undefined;
                            let caption: string | undefined;

                            if (typeof img === 'string') {
                                imageKey = img;
                            } else if (img && typeof img === 'object') {
                                imageKey = img.ImageKey || img.Id || img.id || img.Url || img.url;
                                caption = img.Caption || img.caption;
                            }

                            if (imageKey) {
                                await staticDataRepository.upsertHotelImage({
                                    hotelCode: h.hotelCode,
                                    imageKey: String(imageKey),
                                    displayOrder: i,
                                    caption: caption,
                                });
                            }
                        }
                    }

                    // Sync facilities (Fix: use FacilityName as per docs)
                    if (details.MasterFacilities) {
                        await staticDataRepository.clearHotelFacilities(h.hotelCode);
                        for (const f of details.MasterFacilities) {
                            const fId = f.FacilityId || f.id || f.Id;
                            if (fId === undefined) continue;

                            const facilityName = f.FacilityName || f.Name || f.name || `Facility ${fId}`;

                            await staticDataRepository.upsertFacility({
                                id: fId,
                                name: facilityName,
                            });
                            await staticDataRepository.createHotelFacility({
                                hotelCode: h.hotelCode,
                                facilityId: fId,
                            });
                        }
                    }

                    // Sync textual grouped facilities (RoomFacilities / HotelFacilities)
                    const groupsToCreate: Array<{
                        hotelCode: string;
                        groupType: string;
                        category?: string | null;
                        facilities?: any;
                    }> = [];

                    const pushGroups = (items: any[], groupType: string) => {
                        for (const grp of items) {
                            const category = grp.Category ?? grp.category ?? null;
                            const facilities = grp.Facilities ?? grp.facilities ?? null;
                            groupsToCreate.push({
                                hotelCode: h.hotelCode,
                                groupType,
                                category: category ? String(category) : null,
                                facilities: facilities ?? null,
                            });
                        }
                    };

                    if (Array.isArray(details.RoomFacilities)) {
                        await staticDataRepository.clearHotelFacilityGroups(h.hotelCode, 'ROOM');
                        pushGroups(details.RoomFacilities, 'ROOM');
                    }
                    if (Array.isArray(details.HotelFacilities)) {
                        await staticDataRepository.clearHotelFacilityGroups(h.hotelCode, 'HOTEL');
                        pushGroups(details.HotelFacilities, 'HOTEL');
                    }

                    if (groupsToCreate.length > 0) {
                        await staticDataRepository.createHotelFacilityGroups(groupsToCreate);
                    }

                    recordOutcome(false);
                    processedInCurrentRun++;
                    const absoluteProcessed = startIndex + processedInCurrentRun;

                    // Update progress every 50 hotels to avoid DB spam
                    if (absoluteProcessed % 50 === 0 || absoluteProcessed === totalRecords) {
                        const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

                        // Add slight delay every 50 records (Fix 4)
                        await new Promise(res => setTimeout(res, 200));

                        await staticDataRepository.updateJob(job.id, {
                            processedRecords: absoluteProcessed,
                            lastProcessedKey: h.hotelCode,
                        });
                        logger.info({
                            msg: `Hotel details progress`,
                            processed: `${absoluteProcessed}/${totalRecords}`,
                            elapsed: `${elapsedSeconds}s`,
                            jobId: job.id
                        });
                    }

                } catch (error: any) {
                    if (error.response?.status === 403) {
                        consecutive403++;
                        if (consecutive403 > 20 && !abortReason) {
                            // Stop through the same flag so queued hotels are
                            // skipped too (a throw here only rejected Promise.all
                            // while the rest of the queue kept running).
                            abortReason = 'Too many 403 errors – stopping sync to avoid IP ban';
                            logger.error({ msg: abortReason, jobId: job.id });
                        }
                    }
                    logger.error({ msg: 'Error syncing hotel details', hotelCode: h.hotelCode, error: error.message });
                    recordOutcome(true);
                }
            };

            await Promise.all(hotelsToProcess.map((h, idx) => limit(() => processHotel(h, idx))));

            if (abortReason) {
                // Caught below: job marked FAILED with this reason, then rethrown.
                throw new Error(abortReason);
            }

            // Mark job as completed
            await staticDataRepository.updateJob(job.id, {
                status: JobStatus.COMPLETED,
                completedAt: new Date(),
                processedRecords: totalRecords,
                lastProcessedKey: hotels.length > 0 ? hotels[hotels.length - 1].hotelCode : job.lastProcessedKey,
            });

            logger.info(`Completed hotel details sync - Total time: ${Math.floor((Date.now() - startTime) / 1000)}s`);
        } catch (error: any) {
            await staticDataRepository.updateJob(job.id, {
                status: JobStatus.FAILED,
                errorMessage: error.message,
                completedAt: new Date(),
            });
            logger.error({ msg: 'HOTEL_DETAILS sync failed', jobId: job.id, error: error.message });
            throw error;
        }
    }

    async fullSync() {
        console.log("-----------------1---------------")
        try {
            // Nationalities populate the master.nationalities table that
            // backs the Create Request form's nationality dropdown.
            // Cheap (~200 rows) — runs every Sunday with the rest of the
            // static-data sync. Failures shouldn't block destinations /
            // hotels syncs that follow.
            try {
                await this.syncNationalities();
            } catch (err: any) {
                logger.warn({ msg: 'Nationality sync failed — continuing fullSync', error: err?.message });
            }
            // await this.syncLanguages();
            // await this.syncCurrencies();
            await this.syncDestinations();
            await this.syncHotelsList();
            await this.syncHotelDetails();
        } catch (error: any) {
            logger.error({ msg: 'Full Sync failed', error: error.message });
        }
    }
}

export default new StaticDataService();

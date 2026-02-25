import wbeClientService from './wbe.client.service';
import staticDataRepository from '../repositories/staticData.repository';
import logger from '../utils/logger';

export class StaticDataService {
    constructor() {
        this.syncDestinations = this.syncDestinations.bind(this);
        this.syncHotelsList = this.syncHotelsList.bind(this);
        this.syncHotelDetails = this.syncHotelDetails.bind(this);
        this.fullSync = this.fullSync.bind(this);
    }

    private async syncDestinationRecursive(dest: any, parentId: number | null) {
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
        });

        if (dest.Children && Array.isArray(dest.Children) && dest.Children.length > 0) {
            for (const child of dest.Children) {
                await this.syncDestinationRecursive(child, destId);
            }
        }
    }

    async syncDestinations() {
        console.log('--- syncDestinations() called ---');
        logger.info('Starting destination sync...--------------');
        const countries = await wbeClientService.getDestinations();

        console.log(`Fetched ${countries.length} country/destination groups.`);

        for (const country of countries) {
            if (country.Destinations && Array.isArray(country.Destinations)) {
                for (const dest of country.Destinations) {
                    await this.syncDestinationRecursive(dest, null);
                }
            } else {
                // Handle cases where the top level might be a destination directly
                const destId = country.DestinationId || country.id || country.Id;
                if (destId) {
                    await this.syncDestinationRecursive(country, null);
                }
            }
        }
        logger.info(`Synced destinations from ${countries.length} groups`);
    }

    async syncHotelsList() {
        logger.info('Starting hotels list sync...');
        const hotels = await wbeClientService.getHotels();

        console.log(`Fetched ${hotels.length} hotels in summary list.`);
        if (hotels.length > 0) {
            console.log('Sample hotel list object:', JSON.stringify(hotels[0], null, 2));
        }

        for (const h of hotels) {
            const hotelCode = h.HotelCode || h.hotelCode;
            if (!hotelCode) {
                console.log('Skipping hotel with missing HotelCode:', JSON.stringify(h));
                continue;
            }

            await staticDataRepository.upsertHotel({
                hotelCode: hotelCode,
                name: h.Name || h.name,
                masterHotelId: h.MasterHotelId || h.id || h.id_master,
                hotelDetailsUrl: h.HotelDetailsUrl || h.detailsUrl,
                destinationId: h.DestinationId || h.destination_id,
                starRating: h.StarRating || h.stars,
                category: h.Category || h.category,
                giataCode: h.GiataId ? String(h.GiataId) : h.giata ? String(h.giata) : null,
                lastSyncedAt: new Date(),
            });
        }
        logger.info(`Synced ${hotels.length} hotels (light)`);
    }

    async syncHotelDetails() {
        logger.info('Starting hotel details sync...');
        const hotels = await staticDataRepository.getHotelsNeedingDetails();
        logger.info(`Found ${hotels.length} hotels needing details update`);

        for (const h of hotels) {
            if (!h.hotelDetailsUrl) continue;

            try {
                const details = await wbeClientService.getHotelDetails(h.hotelDetailsUrl);

                if (hotels.indexOf(h) === 0) {
                    console.log('Sample hotel details object:', JSON.stringify(details, null, 2));
                }

                // Update hotel with detailed fields
                await staticDataRepository.upsertHotel({
                    hotelCode: h.hotelCode,
                    name: details.Name || details.name,
                    address: details.Address || details.address,
                    addressCity: details.AddressCity || details.addressCity,
                    addressCountry: details.AddressCountry || details.addressCountry,
                    latitude: details.Latitude || details.latitude,
                    longitude: details.Longitude || details.longitude,
                    metadata: details,
                    detailsFetchedAt: new Date(),
                    lastSyncedAt: new Date(),
                });

                // Sync images
                if (details.Images) {
                    for (let i = 0; i < details.Images.length; i++) {
                        const img = details.Images[i];
                        await staticDataRepository.upsertHotelImage({
                            hotelCode: h.hotelCode,
                            imageKey: img.ImageKey || img.Id || img.id,
                            displayOrder: i,
                            caption: img.Caption || img.caption,
                        });
                    }
                }

                // Sync facilities
                if (details.MasterFacilities) {
                    await staticDataRepository.clearHotelFacilities(h.hotelCode);
                    for (const f of details.MasterFacilities) {
                        const fId = f.FacilityId || f.id || f.Id;
                        if (fId === undefined) continue;

                        await staticDataRepository.upsertFacility({
                            id: fId,
                            name: f.Name || f.name,
                        });
                        await staticDataRepository.createHotelFacility({
                            hotelCode: h.hotelCode,
                            facilityId: fId,
                        });
                    }
                }

            } catch (error: any) {
                logger.error({ msg: 'Error syncing hotel details', hotelCode: h.hotelCode, error: error.message });
            }
        }
        logger.info('Completed hotel details sync');
    }

    async fullSync() {
        console.log("-----------------1---------------")
        try {
            await this.syncDestinations();
            await this.syncHotelsList();
            await this.syncHotelDetails();
        } catch (error: any) {
            logger.error({ msg: 'Full Sync failed', error: error.message });
        }
    }
}

export default new StaticDataService();

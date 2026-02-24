import wbeClientService from './wbe.client.service';
import staticDataRepository from '../repositories/staticData.repository';
import logger from '../utils/logger';

export class StaticDataService {
    async syncDestinations() {
        logger.info('Starting destination sync...');
        const destinations = await wbeClientService.getDestinations();

        // Sort to handle parents before children if hierarchical
        // Assuming API returns flat list or handles it.
        for (const dest of destinations) {
            await staticDataRepository.upsertDestination({
                id: dest.DestinationId,
                name: dest.Name,
                parentId: dest.ParentDestinationId || null,
                lastSyncedAt: new Date(),
            });
        }
        logger.info(`Synced ${destinations.length} destinations`);
    }

    async syncHotelsList() {
        logger.info('Starting hotels list sync...');
        const hotels = await wbeClientService.getHotels();

        for (const h of hotels) {
            await staticDataRepository.upsertHotel({
                hotelCode: h.HotelCode,
                name: h.Name,
                masterHotelId: h.MasterHotelId,
                hotelDetailsUrl: h.HotelDetailsUrl,
                destinationId: h.DestinationId,
                starRating: h.StarRating,
                category: h.Category,
                giataCode: h.GiataId,
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

                // Update hotel with detailed fields
                await staticDataRepository.upsertHotel({
                    hotelCode: h.hotelCode,
                    name: details.Name,
                    address: details.Address,
                    addressCity: details.AddressCity,
                    addressCountry: details.AddressCountry,
                    latitude: details.Latitude,
                    longitude: details.Longitude,
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
                            imageKey: img.ImageKey || img.Id,
                            displayOrder: i,
                            caption: img.Caption,
                        });
                    }
                }

                // Sync facilities
                if (details.MasterFacilities) {
                    await staticDataRepository.clearHotelFacilities(h.hotelCode);
                    for (const f of details.MasterFacilities) {
                        await staticDataRepository.upsertFacility({
                            id: f.FacilityId,
                            name: f.Name,
                        });
                        await staticDataRepository.createHotelFacility({
                            hotelCode: h.hotelCode,
                            facilityId: f.FacilityId,
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

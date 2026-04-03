import hotelRepository from '../repositories/hotel.repository';
import wbeClientService from './wbe.client.service';
import logger from '../utils/logger';

export class HotelService {
    async searchHotels(query: {
        q?: string;
        destinationId?: number;
        starRating?: number;
        limit?: number;
        offset?: number;
    }) {
        return hotelRepository.search(query);
    }

    /**
     * Get full hotel details by hotel code.
     * Returns structured data from the metadata JSON (synced from WBE CDN).
     * If metadata is not yet synced and hotelDetailsUrl is available, fetches on-demand.
     */
    async getHotelDetails(hotelCode: string) {
        const hotel = await hotelRepository.findByCode(hotelCode);
        if (!hotel) {
            throw { status: 404, message: 'Hotel not found', code: 'NOT_FOUND' };
        }

        let meta = hotel.metadata as Record<string, any> | null;

        // If metadata not synced yet, try fetching on-demand from CDN
        if (!meta && hotel.hotelDetailsUrl) {
            try {
                meta = await wbeClientService.getHotelDetails(hotel.hotelDetailsUrl);
            } catch (err: any) {
                logger.warn({ err, hotelCode }, 'On-demand hotel detail fetch failed');
            }
        }

        return {
            hotelCode: hotel.hotelCode,
            name: hotel.name,
            description: meta?.Description || null,
            location: meta?.Location || null,
            address: hotel.address,
            addressCity: hotel.addressCity,
            addressCountry: hotel.addressCountry,
            starRating: hotel.starRating ? Number(hotel.starRating) : null,
            latitude: hotel.latitude ? Number(hotel.latitude) : null,
            longitude: hotel.longitude ? Number(hotel.longitude) : null,
            totalRooms: hotel.totalRooms,
            propertyType: hotel.propertyType,
            category: hotel.category,
            email: meta?.Email || null,
            phone: meta?.Phone || null,
            images: (meta?.Images as string[]) ?? [],
            roomFacilities: meta?.RoomFacilities ?? [],
            hotelFacilities: meta?.HotelFacilities ?? [],
        };
    }
}

export default new HotelService();

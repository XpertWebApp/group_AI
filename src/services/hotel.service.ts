import hotelRepository from '../repositories/hotel.repository';
import wbeClientService from './wbe.client.service';
import logger from '../utils/logger';
import { floorStarRating } from '../utils/starRating';
import giataRepository from '../repositories/giata.repository';
import {
    resolveHotelDescription,
    GIATA_LOCATION_SECTION,
    type SupportedLang,
} from '../utils/hotelDescription';

export class HotelService {
    async searchHotels(query: {
        q?: string;
        destinationId?: number;
        starRating?: number;
        limit?: number;
        offset?: number;
    }) {
        const rows = await hotelRepository.search(query);
        return rows.map((h) => ({
            ...h,
            starRating: floorStarRating(h.starRating ? Number(h.starRating) : null),
        }));
    }

    /**
     * Get full hotel details by hotel code.
     * Returns structured data from the metadata JSON (synced from WBE CDN).
     * If metadata is not yet synced and hotelDetailsUrl is available, fetches on-demand.
     */
    async getHotelDetails(hotelCode: string, lang: SupportedLang = 'en') {
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

        // GIATA Lage / Location section in the requested language, falling back to WBE.
        const giataRows = await giataRepository.getTexts(hotelCode, lang);
        const giataLocation = giataRows.find((r) => r.sectionType === GIATA_LOCATION_SECTION)?.content ?? null;
        const resolved = resolveHotelDescription(giataLocation, meta, lang);

        return {
            hotelCode: hotel.hotelCode,
            name: hotel.name,
            description: resolved.description,
            descriptionLanguage: resolved.descriptionLanguage,
            descriptionSource: resolved.descriptionSource,
            location: meta?.Location || null,
            address: hotel.address,
            addressCity: hotel.addressCity,
            addressCountry: hotel.addressCountry,
            starRating: floorStarRating(hotel.starRating ? Number(hotel.starRating) : null),
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

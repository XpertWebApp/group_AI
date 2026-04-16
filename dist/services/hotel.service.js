"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HotelService = void 0;
const hotel_repository_1 = __importDefault(require("../repositories/hotel.repository"));
const wbe_client_service_1 = __importDefault(require("./wbe.client.service"));
const logger_1 = __importDefault(require("../utils/logger"));
class HotelService {
    async searchHotels(query) {
        return hotel_repository_1.default.search(query);
    }
    /**
     * Get full hotel details by hotel code.
     * Returns structured data from the metadata JSON (synced from WBE CDN).
     * If metadata is not yet synced and hotelDetailsUrl is available, fetches on-demand.
     */
    async getHotelDetails(hotelCode) {
        const hotel = await hotel_repository_1.default.findByCode(hotelCode);
        if (!hotel) {
            throw { status: 404, message: 'Hotel not found', code: 'NOT_FOUND' };
        }
        let meta = hotel.metadata;
        // If metadata not synced yet, try fetching on-demand from CDN
        if (!meta && hotel.hotelDetailsUrl) {
            try {
                meta = await wbe_client_service_1.default.getHotelDetails(hotel.hotelDetailsUrl);
            }
            catch (err) {
                logger_1.default.warn({ err, hotelCode }, 'On-demand hotel detail fetch failed');
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
            images: meta?.Images ?? [],
            roomFacilities: meta?.RoomFacilities ?? [],
            hotelFacilities: meta?.HotelFacilities ?? [],
        };
    }
}
exports.HotelService = HotelService;
exports.default = new HotelService();

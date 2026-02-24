import hotelRepository from '../repositories/hotel.repository';

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
}

export default new HotelService();

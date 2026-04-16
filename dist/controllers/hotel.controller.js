"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HotelController = void 0;
const hotel_service_1 = __importDefault(require("../services/hotel.service"));
const response_1 = require("../utils/response");
class HotelController {
    async search(req, res, next) {
        try {
            const query = req.validated?.query ?? req.query;
            const result = await hotel_service_1.default.searchHotels({
                q: query.q,
                destinationId: query.destinationId,
                starRating: query.starRating,
                limit: query.limit,
                offset: query.offset,
            });
            return (0, response_1.sendResponse)(res, 200, result, 'Hotels retrieved');
        }
        catch (error) {
            next(error);
        }
    }
    async getDetails(req, res, next) {
        try {
            const hotelCode = (req.query.code ?? '').trim();
            if (!hotelCode) {
                return (0, response_1.sendResponse)(res, 400, null, 'code query parameter is required', 'BAD_REQUEST');
            }
            const result = await hotel_service_1.default.getHotelDetails(hotelCode);
            return (0, response_1.sendResponse)(res, 200, result, 'Hotel details retrieved');
        }
        catch (error) {
            next(error);
        }
    }
}
exports.HotelController = HotelController;
exports.default = new HotelController();

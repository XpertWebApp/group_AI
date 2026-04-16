"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishHotelProbeJob = publishHotelProbeJob;
const rabbitmq_client_1 = require("./rabbitmq.client");
const logger_1 = __importDefault(require("../utils/logger"));
async function publishHotelProbeJob(payload) {
    const ch = await (0, rabbitmq_client_1.getChannel)();
    if (!ch) {
        logger_1.default.warn({ jobId: payload.jobId }, 'RabbitMQ not available — cannot publish probe job');
        return;
    }
    ch.sendToQueue(rabbitmq_client_1.HOTEL_PROBE_QUEUE, Buffer.from(JSON.stringify(payload)), { persistent: true });
    logger_1.default.debug({ jobId: payload.jobId, hotelCode: payload.hotelCode }, 'HotelProbeJob published');
}

"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOTEL_PROBE_QUEUE = void 0;
exports.getChannel = getChannel;
exports.closeConnection = closeConnection;
const amqp = __importStar(require("amqplib"));
const logger_1 = __importDefault(require("../utils/logger"));
const probeConfig_1 = require("../config/probeConfig");
exports.HOTEL_PROBE_QUEUE = 'hotel_probe_jobs';
let model = null;
let channel = null;
async function connect() {
    const url = process.env.RABBITMQ_URL ?? 'amqp://localhost';
    try {
        model = await amqp.connect(url);
    }
    catch (err) {
        logger_1.default.warn({ msg: 'RabbitMQ not available — worker features disabled', error: err instanceof Error ? err.message : String(err) });
        return null;
    }
    model.on('error', (err) => {
        logger_1.default.error({ msg: 'RabbitMQ connection error', error: err instanceof Error ? err.message : String(err) });
        channel = null;
        model = null;
    });
    model.on('close', () => {
        logger_1.default.warn('RabbitMQ connection closed');
        channel = null;
        model = null;
    });
    channel = await model.createChannel();
    await channel.assertQueue(exports.HOTEL_PROBE_QUEUE, { durable: true });
    channel.prefetch(probeConfig_1.WORKER_JOB_CONCURRENCY);
    logger_1.default.info('RabbitMQ channel ready');
    return channel;
}
async function getChannel() {
    if (!channel) {
        return connect();
    }
    return channel;
}
async function closeConnection() {
    try {
        if (channel)
            await channel.close();
        if (model)
            await model.close();
    }
    catch {
        // ignore errors on close
    }
    finally {
        channel = null;
        model = null;
    }
}

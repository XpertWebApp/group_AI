"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config({ path: path_1.default.resolve(process.cwd(), '.env'), override: true });
const config = {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '4000', 10),
    corsOrigin: process.env.CORS_ORIGIN || process.env.CLIENT_URL || 'http://localhost:3000',
    jwt: {
        secret: process.env.JWT_SECRET,
        refreshSecret: process.env.JWT_REFRESH_SECRET,
        accessExpiration: process.env.JWT_ACCESS_EXPIRES || '15m',
        refreshExpiration: process.env.JWT_REFRESH_EXPIRES || '30d',
    },
    wbe: {
        apiKey: process.env.WBE_API_KEY,
        baseUrl: process.env.WBE_BASE_URL,
        searchUrl: process.env.WBE_SEARCH_URL || process.env.WBE_BASE_URL,
        contentUrl: process.env.WBE_CONTENT_URL || 'https://uatcontent.wbeapi.com',
        username: process.env.WBE_USERNAME,
        password: process.env.WBE_PASSWORD,
        acceptLanguage: process.env.WBE_ACCEPT_LANGUAGE || 'en',
    },
    giata: {
        mhgBaseUrl: process.env.GIATA_MHG_BASE_URL || 'http://ghgml.giatamedia.com/webservice/rest/1.0',
        multicodesBaseUrl: process.env.GIATA_MULTICODES_BASE_URL || 'https://multicodes.giatamedia.com/webservice/rest/1.latest',
        username: process.env.GIATA_USERNAME || '',
        password: process.env.GIATA_PASSWORD || '',
    },
    webhook: {
        // Wix (legacy, plain secret header)
        wixSecret: process.env.WEBHOOK_SECRET || '',
        // WordPress (HMAC-SHA256)
        wordpressSecret: process.env.WP_WEBHOOK_SECRET || '',
    },
    s3: {
        endpoint: process.env.S3_ENDPOINT || '',
        region: process.env.S3_REGION || 'fsn1',
        bucket: process.env.S3_BUCKET || '',
        accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    },
    logLevel: process.env.LOG_LEVEL || 'info',
};
exports.default = config;

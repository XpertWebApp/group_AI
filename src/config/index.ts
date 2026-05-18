import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

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
        region: process.env.S3_REGION || 'eu-central-1',
        bucket: process.env.S3_BUCKET || '',
        accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    },
    google: {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/api/v1/auth/google/callback',
    },
    logLevel: process.env.LOG_LEVEL || 'info',
};

export default config;

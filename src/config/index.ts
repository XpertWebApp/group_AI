import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const config = {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '4000', 10),
    jwt: {
        secret: process.env.JWT_SECRET,
        refreshSecret: process.env.JWT_REFRESH_SECRET,
        accessExpiration: process.env.JWT_ACCESS_EXPIRES || '15m',
        refreshExpiration: process.env.JWT_REFRESH_EXPIRES || '30d',
    },
    wbe: {
        apiKey: process.env.WBE_API_KEY,
        baseUrl: process.env.WBE_BASE_URL,
        username: process.env.WBE_USERNAME,
        password: process.env.WBE_PASSWORD,
    },
    logLevel: process.env.LOG_LEVEL || 'info',
};

export default config;

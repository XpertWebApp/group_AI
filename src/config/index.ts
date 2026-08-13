import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const config = {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '4000', 10),
    corsOrigin: (process.env.CORS_ORIGIN || process.env.CLIENT_URL || 'http://localhost:3000')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
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
    odoo: {
        url: process.env.ODOO_URL || '',
        db: process.env.ODOO_DB || '',
        username: process.env.ODOO_USERNAME || '',
        apiKey: process.env.ODOO_API_KEY || '',
        // Cutover for the offer-send gate. Requests created BEFORE this
        // timestamp are grandfathered (offer-send works without an Odoo link).
        // Requests created on/after MUST have odooContactId set before send.
        gateActiveSince: process.env.ODOO_GATE_ACTIVE_SINCE || '2026-05-23T00:00:00Z',
    },
    nationality: {
        // Cutover for the silent 'HU' fallback. Requests created BEFORE this
        // timestamp can still hit the 'HU' default in hotelSearch.service.ts
        // when their `nationalityCode` is null (Wix webhook backfill case).
        // Requests created on/after this timestamp will use the staff-picked
        // value — the Zod schema now refuses to accept missing nationality
        // at the API boundary.
        //
        // Once 100% of new requests carry a nationality and the backlog of
        // legacy null rows is drained, this guard can be deleted from
        // hotelSearch.service.ts entirely.
        fallbackCutoffDate: process.env.NATIONALITY_FALLBACK_CUTOFF_DATE || '2026-06-26T00:00:00Z',
    },
    email: {
        // QA / staging safety net. When set, EVERY outbound email is
        // re-routed to this address instead of its real recipient — the
        // original target is preserved in the subject prefix
        // (`[QA → original@…]`) and in an `X-Intended-To` header so QA can
        // verify routing without spamming real customers. Leave UNSET in
        // production. Accepts a single address or a comma-separated list.
        interceptTo: process.env.EMAIL_INTERCEPT_TO || '',
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

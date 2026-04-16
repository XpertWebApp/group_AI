declare const config: {
    env: string;
    port: number;
    corsOrigin: string;
    jwt: {
        secret: string | undefined;
        refreshSecret: string | undefined;
        accessExpiration: string;
        refreshExpiration: string;
    };
    wbe: {
        apiKey: string | undefined;
        baseUrl: string | undefined;
        searchUrl: string | undefined;
        contentUrl: string;
        username: string | undefined;
        password: string | undefined;
        acceptLanguage: string;
    };
    google: {
        clientId: string | undefined;
        clientSecret: string | undefined;
        redirectUri: string;
    };
    giata: {
        mhgBaseUrl: string;
        multicodesBaseUrl: string;
        username: string;
        password: string;
    };
    s3: {
        endpoint: string;
        region: string;
        bucket: string;
        accessKeyId: string;
        secretAccessKey: string;
    };
    logLevel: string;
};
export default config;

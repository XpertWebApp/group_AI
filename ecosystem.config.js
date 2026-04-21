module.exports = {
    apps: [
        {
            name: 'sett-ai-server',
            script: 'dist/server.js',
            instances: '1',
            exec_mode: 'cluster',
            env: {
                NODE_ENV: 'production',
            },
            env_development: {
                NODE_ENV: 'development',
            },
        },
    ],
};

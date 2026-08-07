/**
 * PM2 process configuration.
 *
 * The log settings here exist because the server filled the disk. PM2 captures
 * stdout to a file and, on its own, never rotates or caps it — the file simply
 * grows until something runs out of space. Two things bound it now: the app
 * logs compact JSON in production instead of colourised pretty output (see
 * src/utils/logger.ts), and pm2-logrotate caps and prunes the files.
 *
 * pm2-logrotate is a separate module and is NOT installed by this file. It has
 * to be installed once per machine:
 *
 *   pm2 install pm2-logrotate
 *   pm2 set pm2-logrotate:max_size 50M
 *   pm2 set pm2-logrotate:retain 7
 *   pm2 set pm2-logrotate:compress true
 *   pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
 *
 * Without that, the settings below limit how much is written but nothing
 * prunes what has already been written.
 */
module.exports = {
    apps: [
        {
            name: 'sett-ai-server',
            script: 'dist/server.js',
            instances: '1',
            exec_mode: 'cluster',

            // One file instead of two. PM2 writes stdout and stderr separately
            // by default, which splits a single request's story across files
            // and doubles the number of things to rotate.
            merge_logs: true,
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

            // Restart if the process passes this. A slow leak would otherwise
            // be paged in and out until the machine suffers; a restart is
            // cheap and the queue worker re-subscribes on boot.
            max_memory_restart: '1G',

            // A crash loop can write a stack trace per restart, thousands of
            // times a minute, and fill a disk in minutes. These bound it: wait
            // between restarts, and stop retrying after enough failures so the
            // process stays down and visible rather than spinning.
            min_uptime: '30s',
            max_restarts: 10,
            restart_delay: 5000,

            env: {
                NODE_ENV: 'production',
                // Production default. Set LOG_LEVEL=debug temporarily when
                // diagnosing, then put it back — debug on this codebase is
                // extremely verbose per hotel probe.
                LOG_LEVEL: 'info',
            },
            env_development: {
                NODE_ENV: 'development',
                LOG_LEVEL: 'debug',
            },
        },
    ],
};

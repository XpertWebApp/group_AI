import pino from 'pino';
import dotenv from 'dotenv';

dotenv.config();

/**
 * pino-pretty is a development convenience and a production liability.
 *
 * It was running in every environment, which cost disk twice over: the pretty
 * format is several times larger than the JSON one line for line, and
 * `colorize` writes ANSI escape sequences into what ends up being a file, so
 * every level and message carried `[32m…[39m` bytes that nothing ever renders.
 * PM2 captures stdout to a file that nothing rotates, so it only grew.
 *
 * In production we emit newline-delimited JSON, which is smaller, and which
 * `pm2 logs`, `jq` and any log shipper can actually parse.
 */
const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    ...(isProduction
        ? {}
        : {
              transport: {
                  target: 'pino-pretty',
                  options: {
                      colorize: true,
                      translateTime: 'HH:MM:ss Z',
                      ignore: 'pid,hostname',
                  },
              },
          }),
});

export default logger;

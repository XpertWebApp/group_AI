// Add any global test setup here
import * as dotenv from 'dotenv';
import * as path from 'path';

process.env.NODE_ENV = 'test';

// Load .env.test if it exists (for E2E test configuration)
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

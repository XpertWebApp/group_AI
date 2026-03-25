import express, { Application } from 'express';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import config from './config';
import { errorMiddleware } from './middlewares/error.middleware';
import routes from './routes/index';

const app: Application = express();

// Security Middlewares
app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigin,
    credentials: true,
  })
);

// Body Parser Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Other Middlewares
app.use(cookieParser());
app.use(compression());

// Static assets (email logos, brand images — no auth required)
app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets'), {
    maxAge: '30d',
    immutable: true,
}));

// Health Check
app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/v1', routes);

// Error Handling
app.use(errorMiddleware);

export default app;

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const helmet_1 = __importDefault(require("helmet"));
const cors_1 = __importDefault(require("cors"));
const compression_1 = __importDefault(require("compression"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const config_1 = __importDefault(require("./config"));
const error_middleware_1 = require("./middlewares/error.middleware");
const index_1 = __importDefault(require("./routes/index"));
const app = (0, express_1.default)();
// Trust proxy (needed for correct client IP behind reverse proxy / load balancer)
app.set('trust proxy', 1);
// Security Middlewares
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)({
    origin: config_1.default.corsOrigin,
    credentials: true,
}));
// Body Parser Middlewares
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
// Other Middlewares
app.use((0, cookie_parser_1.default)());
app.use((0, compression_1.default)());
// Static assets (email logos, brand images — no auth required)
app.use('/assets', express_1.default.static(path_1.default.join(__dirname, '..', 'public', 'assets'), {
    maxAge: '30d',
    immutable: true,
}));
// Health Check
app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});
// Routes
app.use('/api/v1', index_1.default);
// Error Handling
app.use(error_middleware_1.errorMiddleware);
exports.default = app;

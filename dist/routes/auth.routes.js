"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = __importDefault(require("../controllers/auth.controller"));
const googleAuth_controller_1 = __importDefault(require("../controllers/googleAuth.controller"));
const validate_middleware_1 = require("../middlewares/validate.middleware");
const auth_schema_1 = require("../models/auth.schema");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const router = (0, express_1.Router)();
router.post('/login', (0, validate_middleware_1.validate)(auth_schema_1.loginSchema), auth_controller_1.default.login);
router.post('/refresh', (0, validate_middleware_1.validate)(auth_schema_1.refreshSchema), auth_controller_1.default.refresh);
router.post('/logout', auth_controller_1.default.logout);
// Google OAuth 2.0 (Gmail API)
router.get('/google/connect', auth_middleware_1.authMiddleware, googleAuth_controller_1.default.connect);
router.get('/google/callback', googleAuth_controller_1.default.callback); // No auth — browser redirect from Google
router.get('/google/status', auth_middleware_1.authMiddleware, googleAuth_controller_1.default.status);
router.post('/google/disconnect', auth_middleware_1.authMiddleware, googleAuth_controller_1.default.disconnect);
exports.default = router;

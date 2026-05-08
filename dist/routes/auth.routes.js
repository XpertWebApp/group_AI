"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = __importDefault(require("../controllers/auth.controller"));
const validate_middleware_1 = require("../middlewares/validate.middleware");
const auth_schema_1 = require("../models/auth.schema");
const router = (0, express_1.Router)();
router.post('/login', (0, validate_middleware_1.validate)(auth_schema_1.loginSchema), auth_controller_1.default.login);
router.post('/refresh', (0, validate_middleware_1.validate)(auth_schema_1.refreshSchema), auth_controller_1.default.refresh);
router.post('/logout', auth_controller_1.default.logout);
exports.default = router;

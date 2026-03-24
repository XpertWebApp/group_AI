import { Router } from 'express';
import authController from '../controllers/auth.controller';
import googleAuthController from '../controllers/googleAuth.controller';
import { validate } from '../middlewares/validate.middleware';
import { loginSchema, refreshSchema } from '../models/auth.schema';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = Router();

router.post('/login', validate(loginSchema), authController.login);
router.post('/refresh', validate(refreshSchema), authController.refresh);
router.post('/logout', authController.logout);

// Google OAuth 2.0 (Gmail API)
router.get('/google/connect', authMiddleware, googleAuthController.connect);
router.get('/google/callback', googleAuthController.callback); // No auth — browser redirect from Google
router.get('/google/status', authMiddleware, googleAuthController.status);
router.post('/google/disconnect', authMiddleware, googleAuthController.disconnect);

export default router;

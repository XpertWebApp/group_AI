import { Router } from 'express';
import authController from '../controllers/auth.controller';
import { validate } from '../middlewares/validate.middleware';
import { loginSchema, refreshSchema } from '../models/auth.schema';

const router = Router();

router.post('/login', validate(loginSchema), authController.login);
router.post('/refresh', validate(refreshSchema), authController.refresh);
router.post('/logout', authController.logout);

export default router;

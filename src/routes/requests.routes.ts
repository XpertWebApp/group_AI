import { Router } from 'express';
import requestsController from '../controllers/requests.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = Router();

router.get('/', authMiddleware, requestsController.list);
router.get('/:id', authMiddleware, requestsController.get);
router.patch('/:id/status', authMiddleware, requestsController.updateStatus);

export default router;

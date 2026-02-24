import { Router } from 'express';
import proposalsController from '../controllers/proposals.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = Router();

router.get('/', authMiddleware, proposalsController.list);
router.get('/:id', authMiddleware, proposalsController.get);
router.post('/', authMiddleware, proposalsController.create);
router.post('/:id/hotels', authMiddleware, proposalsController.addHotel);
router.post('/:id/services', authMiddleware, proposalsController.addService);

export default router;

import express from 'express';
import { type Router } from 'express';
import { getCIIByMmsiController } from '../../../controllers/cii/cii.controller';
import { requireAuth } from '../../../middlewares/auth.middleware';
import { rejectDisallowedOrigin } from '../../../config/cors';

import zvalueRoute from './zvalue.routes';
import anualCIIRoutes from './annualcii.routes';
import dailyCIIRoutes from './dailycii.routes';

const router: Router = express.Router();

// Not a read: every call recomputes the CII from the last AIS segment and
// appends it to the daily CII (calling it repeatedly double counts), and
// may call the weather API. It therefore needs authentication, and a browser
// origin from ALLOWED_ORIGINS, like the mutating routes.
router.get(
  '/data/:mmsi',
  rejectDisallowedOrigin,
  requireAuth,
  getCIIByMmsiController,
);
router.use('/zvalue', zvalueRoute);
router.use('/annual', anualCIIRoutes);
router.use('/daily', dailyCIIRoutes);
export default router;

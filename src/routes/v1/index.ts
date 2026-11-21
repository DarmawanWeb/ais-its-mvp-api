import express from 'express';
import { type Router } from 'express';

import aisRoutes from './ais.routes';
import shipsRoutes from './ships';
import ciiRoutes from './cii';
import portRoutes from './port.routes';
import telemetryRoutes from './telemetry.routes';
import seempRoutes from './seemp.routes';
import illegalTranshipmentRoutes from './illegal-transhipment.routes';
import authRoutes from './auth.routes';
import {
  requireAuthForMutations,
  telemetryApiKeyAuth,
} from '../../middlewares/auth.middleware';

const router: Router = express.Router();

router.use('/auth', authRoutes);

// Fuel meters may authenticate with a key from TELEMETRY_API_KEYS
// (`X-API-Key` header) instead of a Bearer token, on the two routes that
// record fuel readings only.
router.post(['/ships/fuel-data', '/telemetry/:mmsi/fuel'], telemetryApiKeyAuth);

// Every POST/PUT/PATCH/DELETE route below requires authentication (a Bearer
// token from POST /auth/login, the v2 gateway headers when
// TRUST_FORWARD_AUTH=true, or an API key on the routes above). GET routes
// stay public for backwards compatibility; see README "Phase 0 hardening".
router.use(requireAuthForMutations);

router.use('/ais', aisRoutes);
router.use('/ships', shipsRoutes);
router.use('/cii', ciiRoutes);
router.use('/port', portRoutes);
router.use('/telemetry', telemetryRoutes);
router.use('/seemp', seempRoutes);
router.use('/illegal-transhipment', illegalTranshipmentRoutes);

export default router;

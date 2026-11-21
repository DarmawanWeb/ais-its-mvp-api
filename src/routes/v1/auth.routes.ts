import express, { type Router } from 'express';
import config from '../../config/config';
import { loginController } from '../../controllers/auth.controller';
import { createRateLimiter } from '../../middlewares/rate-limit.middleware';
import { validateRequest } from '../../middlewares/validate.middleware';
import { loginValidation } from '../../validation/auth.validation';

const router: Router = express.Router();

const loginRateLimiter = createRateLimiter({
  ...config.auth.loginRateLimit,
  message: 'Too many login attempts, please try again later',
});

router.post(
  '/login',
  loginRateLimiter,
  loginValidation,
  validateRequest,
  loginController,
);

export default router;

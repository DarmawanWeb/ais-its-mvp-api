import type { RequestHandler } from 'express';
import { validationResult } from 'express-validator';

/**
 * Answers 400 when the express-validator chains that ran before it found
 * errors. Submitted values are not echoed back (they may be passwords).
 */
export const validateRequest: RequestHandler = (req, res, next) => {
  const result = validationResult(req);
  if (result.isEmpty()) {
    next();
    return;
  }
  res.status(400).json({
    message: 'Validation failed',
    errors: result.array().map((error) => ({
      field: error.type === 'field' ? error.path : undefined,
      message: String(error.msg),
    })),
    status: 400,
    success: false,
  });
};

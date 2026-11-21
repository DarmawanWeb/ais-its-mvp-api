import { Response, Request } from 'express';

export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({
    message: `Not Found for route darr ${req.originalUrl}`,
    status: 404,
    success: false,
  });
};

export class BaseError extends Error {
  statusCode: number;
  /** Optional machine-readable error code, returned to clients as `code`. */
  code?: string;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class ValidationError extends BaseError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class AuthenticationError extends BaseError {
  constructor(message: string) {
    super(message, 401);
  }
}

export class NotFoundError extends BaseError {
  constructor(message: string) {
    super(message, 404);
  }
}

export class ConflictError extends BaseError {
  constructor(message: string) {
    super(message, 409);
  }
}

/**
 * No CII can be shown for a ship yet (nothing computed, or not enough data to
 * compute it). Replaces the hard-coded "Default CII values" used before.
 */
export class CIINotAvailableError extends NotFoundError {
  constructor(message: string) {
    super(message);
    this.code = 'CII_NOT_AVAILABLE';
  }
}

export class ServiceUnavailableError extends BaseError {
  constructor(message: string) {
    super(message, 503);
  }
}

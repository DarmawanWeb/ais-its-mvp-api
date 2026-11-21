import { body } from 'express-validator';

export const registerValidation = [
  body('name')
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ max: 50 })
    .withMessage('Name must be less than 50 characters'),

  body('email')
    .isEmail()
    .withMessage('Valid email is required')
    .normalizeEmail(),

  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters')
    .matches(/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{6,}$/)
    .withMessage('Password must contain letters and numbers'),
];

// isString() first: arrays and objects would pass the other checks (which
// run on each array item, or on the object's string form) and then make
// bcrypt throw.
export const loginValidation = [
  body('email')
    .isString()
    .withMessage('Valid email is required')
    .bail()
    .isEmail()
    .withMessage('Valid email is required')
    .normalizeEmail(),

  body('password')
    .isString()
    .withMessage('Password must be a string')
    .bail()
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters'),
];

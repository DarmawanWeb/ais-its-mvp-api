import type { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import { handleError } from '../utils/error.handler';

const authService = new AuthService();

export const loginController = async (
  req: Request<unknown, unknown, { email: string; password: string }>,
  res: Response,
): Promise<void> => {
  try {
    const { email, password } = req.body;
    const result = await authService.login(email, password);
    res.status(200).json({
      message: 'Login successful',
      data: result,
      success: true,
    });
  } catch (error) {
    handleError(error, res);
  }
};

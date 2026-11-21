import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/services/auth.service';
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from './test-env';

const admin = {
  email: TEST_ADMIN_EMAIL,
  passwordHash: bcrypt.hashSync(TEST_ADMIN_PASSWORD, 4),
};

describe('AuthService.login', () => {
  it('runs at most two password checks at a time and answers 503 to more', async () => {
    const running: ((matches: boolean) => void)[] = [];
    const compare = vi
      .spyOn(bcrypt, 'compare')
      .mockImplementation(
        () => new Promise<boolean>((resolve) => running.push(resolve)) as never,
      );
    const service = new AuthService(admin);

    const first = service.login(TEST_ADMIN_EMAIL, 'wrong-password');
    const second = service.login(TEST_ADMIN_EMAIL, 'wrong-password');
    await vi.waitFor(() => expect(running).toHaveLength(2));

    await expect(
      service.login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD),
    ).rejects.toMatchObject({
      statusCode: 503,
      message: 'Too many login attempts at once, please try again',
    });
    expect(compare).toHaveBeenCalledTimes(2);

    running.forEach((finish) => finish(false));
    await expect(first).rejects.toMatchObject({ statusCode: 401 });
    await expect(second).rejects.toMatchObject({ statusCode: 401 });

    compare.mockRestore();
    await expect(
      service.login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD),
    ).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  it('frees the slot when bcrypt fails', async () => {
    vi.spyOn(bcrypt, 'compare').mockRejectedValueOnce(new Error('boom'));
    const service = new AuthService(admin, 1);

    await expect(
      service.login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD),
    ).rejects.toThrow('boom');
    await expect(
      service.login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD),
    ).resolves.toMatchObject({ tokenType: 'Bearer' });
  });
});

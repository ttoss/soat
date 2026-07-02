import { signFileDownloadToken } from 'src/lib/fileDownloadToken';

import { authenticatedTestClient } from '../../testClient';

describe('auth middleware', () => {
  describe('JWT_SECRET requirement', () => {
    test('module throws at load time when JWT_SECRET is unset', () => {
      const previousSecret = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;

      expect(() => {
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('src/middleware/auth');
        });
      }).toThrow('JWT_SECRET environment variable is not set');

      process.env.JWT_SECRET = previousSecret;
    });
  });

  describe('download token replayed as a Bearer session token', () => {
    test('is rejected with 401, not a 500 from an undefined publicId lookup', async () => {
      const token = signFileDownloadToken({ fileId: 'fil_nonexistent' });

      const response =
        await authenticatedTestClient(token).get('/api/v1/projects');

      expect(response.status).toBe(401);
    });
  });
});

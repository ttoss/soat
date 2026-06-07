import * as fs from 'node:fs';

import { resolveClient } from '../../../src/config';

jest.mock('node:fs');

const mockReadFileSync = jest.mocked(fs.readFileSync);

const PROFILE_STORE = JSON.stringify({
  default: { baseUrl: 'https://profile.example.com', token: 'profile-token' },
  staging: { baseUrl: 'https://staging.example.com', token: 'staging-token' },
});

const makeFetchMock = () => {
  const requests: { url: string; authorization: string | null }[] = [];
  const mock = jest.fn(async (req: Request) => {
    requests.push({
      url: req.url,
      authorization: req.headers.get('Authorization'),
    });
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { mock, requests };
};

describe('CLI auth flows', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env['SOAT_BASE_URL'];
    delete process.env['SOAT_API_KEY'];
    delete process.env['SOAT_PROFILE'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('env var auth (SOAT_BASE_URL + SOAT_API_KEY)', () => {
    test('uses both env vars directly when both are set', async () => {
      process.env['SOAT_BASE_URL'] = 'https://env.example.com';
      process.env['SOAT_API_KEY'] = 'env-token';

      const { mock, requests } = makeFetchMock();
      globalThis.fetch = mock as unknown as typeof fetch;

      const client = resolveClient();
      // Make an actual SDK call to observe which credentials are used
      const sdkSdk = await import('@soat/sdk');
      await sdkSdk.Users.bootstrapUser({
        client,
        body: { username: 'u', password: 'p' },
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toContain('https://env.example.com');
      expect(requests[0]?.authorization).toBe('Bearer env-token');
    });

    test('does not consult the config file when both env vars are set', () => {
      process.env['SOAT_BASE_URL'] = 'https://env.example.com';
      process.env['SOAT_API_KEY'] = 'env-token';

      resolveClient();

      expect(mockReadFileSync).not.toHaveBeenCalled();
    });
  });

  describe('profile-based auth', () => {
    test('uses the default profile when no env vars are set', async () => {
      mockReadFileSync.mockReturnValue(PROFILE_STORE);

      const { mock, requests } = makeFetchMock();
      globalThis.fetch = mock as unknown as typeof fetch;

      const client = resolveClient();
      const sdkSdk = await import('@soat/sdk');
      await sdkSdk.Users.bootstrapUser({
        client,
        body: { username: 'u', password: 'p' },
      });

      expect(requests[0]?.url).toContain('https://profile.example.com');
      expect(requests[0]?.authorization).toBe('Bearer profile-token');
    });

    test('selects a profile by SOAT_PROFILE env var', async () => {
      process.env['SOAT_PROFILE'] = 'staging';
      mockReadFileSync.mockReturnValue(PROFILE_STORE);

      const { mock, requests } = makeFetchMock();
      globalThis.fetch = mock as unknown as typeof fetch;

      const client = resolveClient();
      const sdkSdk = await import('@soat/sdk');
      await sdkSdk.Users.bootstrapUser({
        client,
        body: { username: 'u', password: 'p' },
      });

      expect(requests[0]?.url).toContain('https://staging.example.com');
      expect(requests[0]?.authorization).toBe('Bearer staging-token');
    });

    test('selects a profile by the profileName argument', async () => {
      mockReadFileSync.mockReturnValue(PROFILE_STORE);

      const { mock, requests } = makeFetchMock();
      globalThis.fetch = mock as unknown as typeof fetch;

      const client = resolveClient('staging');
      const sdkSdk = await import('@soat/sdk');
      await sdkSdk.Users.bootstrapUser({
        client,
        body: { username: 'u', password: 'p' },
      });

      expect(requests[0]?.url).toContain('https://staging.example.com');
      expect(requests[0]?.authorization).toBe('Bearer staging-token');
    });

    test('profileName argument takes precedence over SOAT_PROFILE env var', async () => {
      process.env['SOAT_PROFILE'] = 'staging';
      mockReadFileSync.mockReturnValue(PROFILE_STORE);

      const { mock, requests } = makeFetchMock();
      globalThis.fetch = mock as unknown as typeof fetch;

      const client = resolveClient('default');
      const sdkSdk = await import('@soat/sdk');
      await sdkSdk.Users.bootstrapUser({
        client,
        body: { username: 'u', password: 'p' },
      });

      expect(requests[0]?.url).toContain('https://profile.example.com');
      expect(requests[0]?.authorization).toBe('Bearer profile-token');
    });

    test('SOAT_BASE_URL overrides the profile base URL while keeping the profile token', async () => {
      process.env['SOAT_BASE_URL'] = 'https://override.example.com';
      // SOAT_API_KEY is NOT set — falls through to profile lookup
      mockReadFileSync.mockReturnValue(PROFILE_STORE);

      const { mock, requests } = makeFetchMock();
      globalThis.fetch = mock as unknown as typeof fetch;

      const client = resolveClient();
      const sdkSdk = await import('@soat/sdk');
      await sdkSdk.Users.bootstrapUser({
        client,
        body: { username: 'u', password: 'p' },
      });

      expect(requests[0]?.url).toContain('https://override.example.com');
      expect(requests[0]?.authorization).toBe('Bearer profile-token');
    });
  });

  describe('unauthenticated fallback', () => {
    test('creates unauthenticated client when SOAT_BASE_URL is set but no profile exists', async () => {
      process.env['SOAT_BASE_URL'] = 'https://env.example.com';
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const { mock, requests } = makeFetchMock();
      globalThis.fetch = mock as unknown as typeof fetch;

      const client = resolveClient();
      const sdkSdk = await import('@soat/sdk');
      await sdkSdk.Users.bootstrapUser({
        client,
        body: { username: 'u', password: 'p' },
      });

      expect(requests[0]?.url).toContain('https://env.example.com');
      expect(requests[0]?.authorization).toBeNull();
    });
  });

  describe('failure cases', () => {
    test('prints error and exits with code 1 when no profile and no SOAT_BASE_URL', () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const exitSpy = jest
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as never);
      const errorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      resolveClient();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Profile "default" not found')
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test('prints the missing profile name in the error message', () => {
      process.env['SOAT_PROFILE'] = 'missing-profile';
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const exitSpy = jest
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as never);
      const errorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      resolveClient();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Profile "missing-profile" not found')
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test('includes --profile hint in error when a non-default profile is missing', () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const exitSpy = jest
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as never);
      const errorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      resolveClient('custom-profile');

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--profile custom-profile')
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test('does not include --profile hint when the default profile is missing', () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const exitSpy = jest
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as never);
      const errorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      resolveClient();

      const errorMsg = errorSpy.mock.calls.flat().join(' ');
      expect(errorMsg).not.toContain('--profile default');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});

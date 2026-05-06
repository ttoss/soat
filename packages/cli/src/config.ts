import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createClient, createConfig } from '@soat/sdk';

export interface Profile {
  baseUrl: string;
  token: string;
}

export type Config = Record<string, Profile>;

const CONFIG_FILE = path.join(os.homedir(), '.soat', 'config.json');

export const readConfig = (): Config => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Config;
  } catch {
    return {};
  }
};

export const writeProfile = (name: string, profile: Profile): void => {
  const config = readConfig();
  config[name] = profile;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
};

export const resolveClient = (
  profileName?: string
): ReturnType<typeof createClient> => {
  const envBaseUrl = process.env['SOAT_BASE_URL'];
  const envToken = process.env['SOAT_TOKEN'];

  // 1. Both env vars set — use them directly, no profile needed.
  if (envBaseUrl && envToken) {
    return createClient(
      createConfig({
        baseUrl: envBaseUrl,
        headers: { Authorization: `Bearer ${envToken}` },
      })
    );
  }

  // 2. Try profile (arg → SOAT_PROFILE env → 'default').
  //    SOAT_BASE_URL overrides the profile's stored baseUrl when present.
  const name = profileName ?? process.env['SOAT_PROFILE'] ?? 'default';
  const config = readConfig();
  const profile = config[name];

  if (profile) {
    return createClient(
      createConfig({
        baseUrl: envBaseUrl ?? profile.baseUrl,
        headers: { Authorization: `Bearer ${profile.token}` },
      })
    );
  }

  // 3. No profile found — if SOAT_BASE_URL is set, create an unauthenticated
  //    client (useful for public endpoints like /health).
  if (envBaseUrl) {
    return createClient(createConfig({ baseUrl: envBaseUrl }));
  }

  // eslint-disable-next-line no-console
  console.error(
    `Profile "${name}" not found. Run: soat configure${name !== 'default' ? ` --profile ${name}` : ''}`
  );
  process.exit(1);
};

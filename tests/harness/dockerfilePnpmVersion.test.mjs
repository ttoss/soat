import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import * as url from 'node:url';

/**
 * The Dockerfile installs pnpm with an explicit `npm install -g pnpm@X` pin,
 * once per build stage, while `package.json` declares the version everything
 * else uses through `packageManager` (CI resolves it via `pnpm/action-setup`).
 * A stale image pin ships a pnpm, and its advisories, that no contributor
 * runs, so the copies must stay equal. Node images from 25 on ship no
 * corepack, so a `corepack` step fails the image build.
 */

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '../..');

/** Matches the pin in `RUN npm install -g pnpm@X`. */
const NPM_PIN = /npm install -g pnpm@(\S+?)(?:\s|$)/g;

const readPackageManagerVersion = () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')
  );

  const declared = manifest.packageManager;

  assert.ok(
    typeof declared === 'string' && declared.startsWith('pnpm@'),
    `root package.json must declare a pnpm "packageManager", got ${JSON.stringify(declared)}`
  );

  return declared.slice('pnpm@'.length);
};

describe('Dockerfile pnpm pins', () => {
  test('no stage relies on corepack', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf-8');

    assert.doesNotMatch(
      dockerfile,
      /^\s*RUN\b.*\bcorepack\b/m,
      'the Node base image ships no corepack; install pnpm with `npm install -g pnpm@…`'
    );
  });

  test('every pnpm pin matches the declared packageManager', () => {
    const expected = readPackageManagerVersion();
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf-8');

    const pins = [...dockerfile.matchAll(NPM_PIN)].map((match) => {
      return match[1];
    });

    assert.ok(
      pins.length > 0,
      'expected the Dockerfile to install pnpm via `npm install -g pnpm@…`'
    );

    for (const pin of pins) {
      assert.equal(
        pin,
        expected,
        `Dockerfile pins pnpm@${pin} but package.json declares pnpm@${expected} — ` +
          'bump both together, or the image ships a different pnpm than CI'
      );
    }
  });
});

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import * as url from 'node:url';

/**
 * The Dockerfile installs pnpm with an explicit `corepack prepare pnpm@X`
 * pin, once per build stage, while `package.json` declares the version
 * everything else uses through `packageManager` (CI resolves it via
 * `pnpm/action-setup`, which reads that field and takes no version input).
 *
 * Nothing tied the two together, so they drifted: the published
 * `ttoss/soat:latest` image shipped pnpm 10.33.2 against a `packageManager`
 * of 11.5.2 — 15 open advisories baked into every image layer that ran an
 * install, three of which Docker Scout surfaced on the tag page (one
 * critical). The drift is invisible locally, because a contributor's pnpm
 * comes from `packageManager` and never from the Dockerfile.
 *
 * A version bump is only as good as the thing that keeps the copies equal,
 * so assert equality rather than any particular version: this fails on the
 * next stage added with a stale pin, and on a `packageManager` bump that
 * forgets the image.
 */

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '../..');

/** Matches the pin in `RUN corepack enable && corepack prepare pnpm@X --activate`. */
const COREPACK_PIN = /corepack prepare pnpm@(\S+?)(?:\s|$)/g;

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
  test('every corepack pin matches the declared packageManager', () => {
    const expected = readPackageManagerVersion();
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf-8');

    const pins = [...dockerfile.matchAll(COREPACK_PIN)].map((match) => {
      return match[1];
    });

    assert.ok(
      pins.length > 0,
      'expected the Dockerfile to install pnpm via `corepack prepare pnpm@…`'
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

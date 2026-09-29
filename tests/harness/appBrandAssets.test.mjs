import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import * as url from 'node:url';

/**
 * The web console ships inside the self-hosted server image, and the quick
 * start runs that server offline. Its brand — favicon, Vector Galaxy mark and
 * the three typefaces — therefore has to ship in the bundle: a remote URL
 * renders as a broken image and fallback fonts on an offline install, and on
 * every other install it reports each console load to a third-party origin.
 *
 * The console keeps its own copies of the website's brand files because the
 * Docker build context holds `packages/app` and not `packages/website`. The
 * copies are held byte-identical to the originals, so a logo change is one
 * change made in two places or a red test.
 */

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '../..');

const APP = path.join(ROOT, 'packages/app');

/** App copy → the website original it mirrors. */
export const MIRRORED_BRAND_FILES = {
  'packages/app/public/favicon.ico': 'packages/website/static/img/favicon.ico',
  'packages/app/src/assets/soat-logo-no-bg.png':
    'packages/website/static/img/soat-logo-no-bg.png',
};

/**
 * Origins the console's brand must not load from at runtime. The website is
 * matched by host, since a base URL joined to a path never spells the path.
 */
const REMOTE_BRAND_ORIGINS = [
  'soat.ttoss.dev',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

const listSources = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    return /\.(tsx?|css|html)$/.test(entry.name) ? [full] : [];
  });
};

const remoteOriginsIn = (file) => {
  const source = fs.readFileSync(file, 'utf-8');
  return REMOTE_BRAND_ORIGINS.filter((origin) => {
    return source.includes(origin);
  }).map((origin) => {
    return `${path.relative(ROOT, file)}: ${origin}`;
  });
};

describe('web console brand assets', () => {
  test('index.html loads nothing from a remote origin', () => {
    const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf-8');
    const remote = [...html.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)].map(
      (match) => {
        return match[1];
      }
    );

    assert.deepEqual(remote, []);
  });

  test('no console source points at a remote brand origin', () => {
    assert.deepEqual(
      listSources(path.join(APP, 'src')).flatMap(remoteOriginsIn),
      []
    );
  });

  test('every bundled brand file is byte-identical to the website original', () => {
    const offenders = Object.entries(MIRRORED_BRAND_FILES)
      .filter(([copy, original]) => {
        const copyPath = path.join(ROOT, copy);
        return (
          !fs.existsSync(copyPath) ||
          !fs
            .readFileSync(copyPath)
            .equals(fs.readFileSync(path.join(ROOT, original)))
        );
      })
      .map(([copy, original]) => {
        return `${copy} does not mirror ${original}`;
      });

    assert.deepEqual(offenders, []);
  });
});

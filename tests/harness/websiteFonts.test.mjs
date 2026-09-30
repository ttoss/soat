import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import * as url from 'node:url';

import { listCss } from './cssRules.mjs';

/**
 * The website's typefaces ship with the site. A stylesheet `@import` from a
 * font host is a render-blocking chain (page CSS, then the host's CSS, then
 * the font files) before any text paints, and it reports every page view to a
 * third party. The fonts are bundled from `@fontsource/*` instead, as the
 * console does (`appBrandAssets.test.mjs`).
 */

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const WEBSITE = path.resolve(__dirname, '../../packages/website');

const FONT_HOSTS = /fonts\.(googleapis|gstatic)\.com|use\.typekit\.net|fonts\.bunny\.net/;

/** The brand typefaces, each a dependency the site bundles. */
const TYPEFACES = [
  '@fontsource/inter',
  '@fontsource/jetbrains-mono',
  '@fontsource/space-grotesk',
];

describe('website fonts', () => {
  test('no website stylesheet or config loads a font from a remote host', () => {
    const sources = [
      ...listCss(path.join(WEBSITE, 'src')),
      path.join(WEBSITE, 'docusaurus.config.ts'),
      path.join(WEBSITE, 'src/data/structuredData.ts'),
    ];
    const offenders = sources
      .filter((file) => {
        return FONT_HOSTS.test(fs.readFileSync(file, 'utf-8'));
      })
      .map((file) => {
        return path.relative(WEBSITE, file);
      });

    assert.deepEqual(offenders, []);
  });

  test('the website depends on every brand typeface it bundles', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(WEBSITE, 'package.json'), 'utf-8')
    );
    const missing = TYPEFACES.filter((name) => {
      return !pkg.dependencies?.[name];
    });

    assert.deepEqual(missing, []);
  });
});

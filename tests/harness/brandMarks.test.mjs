import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import * as url from 'node:url';

import { parseRules } from './cssRules.mjs';

/**
 * The SOAT mark is the core held between two brackets: an outlined
 * `S[•]AT` wordmark and the `[•]` symbol, one SVG master per theme in
 * `packages/website/static/img/brand/`. Every surface draws the mark from
 * those masters, so the colours they paint are the `--process-boundary` and
 * `--process-core` tokens of `soat-design` and nothing else.
 *
 * The mark is a graphic, so each colour needs 3:1 against the page it sits on
 * (WCAG 1.4.11). The retired Vector Galaxy rasters stay at their URLs because
 * released servers and consoles still load them, but they now carry the new
 * mark and no current source draws them.
 */

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '../..');

const BRAND_DIR = path.join(ROOT, 'packages/website/static/img/brand');

const STATIC_DIR = path.join(ROOT, 'packages/website/static');

/** Width and height from a PNG's IHDR chunk. */
const pngSize = (file) => {
  const header = fs.readFileSync(file).subarray(0, 24);
  assert.equal(
    header.toString('latin1', 12, 16),
    'IHDR',
    `${file} is not a PNG`
  );
  return [header.readUInt32BE(16), header.readUInt32BE(20)];
};

const DESIGN_COLORS = path.join(
  ROOT,
  '.claude/skills/soat-design/tokens/colors.css'
);

/** Theme → the page colour the mark sits on and the token block it reads. */
const THEMES = {
  dark: { page: '#080c14', selectors: [':root', ":root[data-theme='dark']"] },
  light: { page: '#ffffff', selectors: [':root'] },
};

const MASTERS = ['soat-symbol', 'soat-wordmark'];

const MIN_GRAPHIC_RATIO = 3;

const read = (file) => {
  return fs.readFileSync(file, 'utf-8');
};

const colorsIn = (svg) => {
  return [
    ...new Set(
      [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)]
        .map((match) => {
          return match[1].toLowerCase();
        })
        .filter((color) => {
          return color !== 'none';
        })
    ),
  ].sort();
};

const luminance = (hex) => {
  const channels = [1, 3, 5].map((offset) => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => {
    return y - x;
  });
  return (hi + 0.05) / (lo + 0.05);
};

/** The `--process-*` tokens a theme resolves to, later blocks winning. */
const processTokens = (theme) => {
  const wanted = THEMES[theme].selectors;
  const declarations = parseRules(read(DESIGN_COLORS))
    .filter((rule) => {
      return rule.selectors.some((selector) => {
        return wanted.includes(selector);
      });
    })
    .reduce((merged, rule) => {
      return { ...merged, ...rule.declarations };
    }, {});
  return [declarations['--process-boundary'], declarations['--process-core']]
    .filter(Boolean)
    .map((value) => {
      return value.toLowerCase();
    })
    .sort();
};

const listSources = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    return /\.(tsx?|css|html|mjs)$/.test(entry.name) ? [full] : [];
  });
};

describe('brand marks', () => {
  for (const theme of Object.keys(THEMES)) {
    for (const master of MASTERS) {
      test(`${master}-${theme}.svg paints exactly the theme's process tokens`, () => {
        const tokens = processTokens(theme);
        assert.equal(
          tokens.length,
          2,
          `--process-* tokens missing for ${theme}`
        );

        const svg = read(path.join(BRAND_DIR, `${master}-${theme}.svg`));

        assert.deepEqual(colorsIn(svg), [...new Set(tokens)].sort());
      });
    }

    test(`the ${theme} process tokens clear 3:1 on the ${theme} page`, () => {
      const tokens = processTokens(theme);
      assert.equal(tokens.length, 2, `--process-* tokens missing for ${theme}`);
      const failing = tokens.filter((color) => {
        return contrast(color, THEMES[theme].page) < MIN_GRAPHIC_RATIO;
      });

      assert.deepEqual(failing, []);
    });
  }

  test('the one-colour masters paint only currentColor', () => {
    for (const master of MASTERS) {
      const svg = read(path.join(BRAND_DIR, `${master}-mono.svg`));
      assert.deepEqual(colorsIn(svg), ['currentcolor'], master);
    }
  });

  test('the SVG favicon follows the colour scheme with the process tokens', () => {
    const svg = read(path.join(BRAND_DIR, 'favicon.svg'));
    const scheme =
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([^}]*\}[^}]*\})\}/.exec(
        svg
      );
    assert.ok(scheme, 'favicon.svg has no dark-scheme block');
    const darkColors = [...scheme[1].matchAll(/#[0-9a-f]{6}/gi)].map((m) => {
      return m[0].toLowerCase();
    });
    const lightColors = [
      ...svg.replace(scheme[0], '').matchAll(/#[0-9a-f]{6}/gi),
    ].map((m) => {
      return m[0].toLowerCase();
    });

    assert.deepEqual([...darkColors].sort(), processTokens('dark'));
    assert.deepEqual([...lightColors].sort(), processTokens('light'));
  });

  test('the website links the SVG favicon', () => {
    assert.match(
      read(path.join(ROOT, 'packages/website/src/data/structuredData.ts')),
      /img\/brand\/favicon\.svg/
    );
  });

  test('no current source draws the retired Vector Galaxy', () => {
    const offenders = ['packages/website/src', 'packages/app/src']
      .flatMap((dir) => {
        return listSources(path.join(ROOT, dir));
      })
      .filter((file) => {
        const source = read(file);
        return (
          source.includes('VectorGalaxy') ||
          source.includes('soat-logo-no-bg') ||
          source.includes('galaxy-gradient')
        );
      })
      .map((file) => {
        return path.relative(ROOT, file);
      });

    assert.deepEqual(offenders, []);
  });
});

describe('device icons', () => {
  /**
   * The icons a device takes from the site: iOS a 180 px touch icon, Android
   * and install prompts the manifest, the browser chrome a theme colour per
   * scheme. A declared size that disagrees with the file is resized by the
   * device, which blurs the 16 px-accurate strokes.
   */
  test('the touch icon and the manifest icons are the sizes they declare', () => {
    const touch = pngSize(path.join(STATIC_DIR, 'apple-touch-icon.png'));
    assert.deepEqual(touch, [180, 180]);

    const manifest = JSON.parse(
      read(path.join(STATIC_DIR, 'site.webmanifest'))
    );
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
    for (const icon of manifest.icons) {
      const [w, h] = icon.sizes.split('x').map(Number);
      assert.deepEqual(
        pngSize(path.join(STATIC_DIR, icon.src.replace(/^\//, ''))),
        [w, h],
        icon.src
      );
    }
    assert.equal(manifest.theme_color.toLowerCase(), THEMES.dark.page);
    assert.equal(manifest.background_color.toLowerCase(), THEMES.dark.page);
  });

  test('the site head links the touch icon, the manifest and both theme colours', () => {
    const head = read(
      path.join(ROOT, 'packages/website/src/data/structuredData.ts')
    );

    assert.match(
      head,
      /rel: 'apple-touch-icon',\s*href: '\/apple-touch-icon\.png'/
    );
    assert.match(head, /rel: 'manifest',\s*href: '\/site\.webmanifest'/);
    for (const [scheme, page] of [
      ['light', THEMES.light.page],
      ['dark', THEMES.dark.page],
    ]) {
      assert.match(
        head,
        new RegExp(
          `name: 'theme-color',\\s*content: '${page}',\\s*media: '\\(prefers-color-scheme: ${scheme}\\)'`
        ),
        scheme
      );
    }
  });
});

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import * as url from 'node:url';

import { readRules, stripComments } from './cssRules.mjs';

/**
 * The palette follows the mark: one brand hue (Electric Blue in light, Core
 * Cyan in dark) on flat Space Black or white. Violet is a diagram colour, a
 * solid stroke or fill that tells one part of a diagram from another, so it
 * never enters a gradient. Page and section backgrounds are flat: no radial
 * glow behind them. Dot grids (a radial stop with no position) and masks are
 * patterns, not glows, and stay.
 */

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '../..');

const DESIGN_DIR = path.join(ROOT, '.claude/skills/soat-design');

/** Every way the sources spell the brand violets. */
const VIOLETS = [
  '--soat-violet',
  '--brand-violet',
  '#8e44ad',
  '#7d3c9d',
  '#a855c7',
  '#b06ad0',
  'rgba(142, 68, 173',
];

/** A gradient call with up to two levels of nested parentheses. */
const GRADIENT =
  /(?:linear|radial|conic)-gradient\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g;

/** A radial gradient placed at a point: the shape of a glow. */
const GLOW = /radial-gradient\(\s*(?:circle|ellipse)\b[^,)]*\bat\b/;

const BACKGROUND_PROPERTIES = ['background', 'background-image'];

const listFiles = (args) => {
  if (!fs.existsSync(args.dir)) return [];
  return fs.readdirSync(args.dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(args.dir, entry.name);
    if (entry.isDirectory()) return listFiles({ ...args, dir: full });
    if (/\.test\.[jt]sx?$/.test(entry.name)) return [];
    return args.extensions.some((ext) => {
      return entry.name.endsWith(ext);
    })
      ? [full]
      : [];
  });
};

const SOURCES = [
  { dir: 'packages/website/src', extensions: ['.css', '.tsx', '.ts'] },
  { dir: 'packages/app/src', extensions: ['.css', '.tsx', '.ts'] },
  { dir: '.claude/skills/soat-design/tokens', extensions: ['.css'] },
  { dir: '.claude/skills/soat-design/components', extensions: ['.jsx'] },
  { dir: '.claude/skills/soat-design/guidelines', extensions: ['.html'] },
].flatMap((source) => {
  return listFiles({ ...source, dir: path.join(ROOT, source.dir) });
});

const relative = (file) => {
  return path.relative(ROOT, file);
};

const hasViolet = (text) => {
  return VIOLETS.some((violet) => {
    return text.includes(violet);
  });
};

/** Every gradient in `file` with a violet stop. */
const violetGradientsIn = (file) => {
  const text = stripComments(fs.readFileSync(file, 'utf-8')).toLowerCase();
  return [...text.matchAll(GRADIENT)]
    .map((match) => {
      return match[0];
    })
    .filter(hasViolet)
    .map((gradient) => {
      return `${relative(file)}: ${gradient.slice(0, 60)}`;
    });
};

const paintsBackground = ([property, value]) => {
  return (
    (BACKGROUND_PROPERTIES.includes(property) || property.startsWith('--')) &&
    GLOW.test(value)
  );
};

/** Every background declaration in a stylesheet that paints a radial glow. */
const cssGlowsIn = (file) => {
  return readRules(file).flatMap((rule) => {
    return Object.entries(rule.declarations)
      .filter(paintsBackground)
      .map(([property]) => {
        return `${relative(file)}: ${rule.selectors.join(', ')} { ${property} }`;
      });
  });
};

/** A component that paints a radial glow inline. */
const inlineGlowsIn = (file) => {
  return GLOW.test(fs.readFileSync(file, 'utf-8')) ? [relative(file)] : [];
};

describe('brand palette', () => {
  test('no source paints violet into a gradient', () => {
    assert.deepEqual(SOURCES.flatMap(violetGradientsIn), []);
  });

  test('no page or section background carries a radial glow', () => {
    const offenders = SOURCES.flatMap((file) => {
      if (file.endsWith('.css')) return cssGlowsIn(file);
      return /\.(tsx|jsx)$/.test(file) ? inlineGlowsIn(file) : [];
    });

    assert.deepEqual(offenders, []);
  });

  test('the design tokens define no gradient to reach for', () => {
    const colors = fs.readFileSync(
      path.join(DESIGN_DIR, 'tokens/colors.css'),
      'utf-8'
    );
    const gradientTokens = [
      ...stripComments(colors).matchAll(/(--gradient-[\w-]+)\s*:/g),
    ].map((match) => {
      return match[1];
    });

    assert.deepEqual([...new Set(gradientTokens)], []);
  });
});

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import * as url from 'node:url';

import { listCss, parseRules, splitAtRule } from './cssRules.mjs';

/**
 * The brand allows continuous motion in two places only — faint background
 * marks and data-flow connectors (`soat-design` readme, Animation) — and
 * every such loop stops for a reader who asked the OS for
 * reduced motion. The stop lives in the same stylesheet as the loop, so the
 * two are edited together.
 */

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '../..');

const STYLESHEET_ROOTS = ['packages/website/src', 'packages/app/src'];

const REDUCED_MOTION = /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/g;

/** Selectors running an infinite animation with no reduced-motion stop. */
const unstoppedLoops = (file) => {
  const { inside, outside } = splitAtRule({
    css: fs.readFileSync(file, 'utf-8'),
    prelude: REDUCED_MOTION,
  });
  const stopped = new Set(
    inside
      .flatMap(parseRules)
      .filter((rule) => {
        return /^none\b/.test(rule.declarations.animation ?? '');
      })
      .flatMap((rule) => {
        return rule.selectors;
      })
  );
  return parseRules(outside)
    .filter((rule) => {
      return /\binfinite\b/.test(rule.declarations.animation ?? '');
    })
    .flatMap((rule) => {
      return rule.selectors;
    })
    .filter((selector) => {
      return !stopped.has(selector);
    })
    .map((selector) => {
      return `${path.relative(ROOT, file)}: ${selector}`;
    });
};

describe('reduced motion', () => {
  test('every infinite animation stops under prefers-reduced-motion', () => {
    const stylesheets = STYLESHEET_ROOTS.flatMap((dir) => {
      return listCss(path.join(ROOT, dir));
    });

    assert.deepEqual(stylesheets.flatMap(unstoppedLoops), []);
  });
});

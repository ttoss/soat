import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import * as url from 'node:url';

import {
  buildDesignBundle,
  DESIGN_BUNDLE,
  DESIGN_DIR,
} from '../../scripts/buildDesignBundle.mjs';

/**
 * The `soat-design` specimen cards are the brand book an agent or a designer
 * opens to see the system. A card whose logo or component bundle does not
 * resolve renders an empty frame, and reads as the brand having no logo.
 *
 * `_ds_bundle.js` is generated from `components/**\/*.jsx`, so the cards show
 * the components as they are: a component edit without a rebuild fails here.
 */

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '../..');

const listHtml = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listHtml(full);
    return entry.name.endsWith('.html') ? [full] : [];
  });
};

const unresolvedReferences = (file) => {
  const html = fs.readFileSync(file, 'utf-8');
  return [...html.matchAll(/\b(?:src|href)="([^"#?]+)[^"]*"/g)]
    .map((match) => {
      return match[1];
    })
    .filter((ref) => {
      return (
        !/^[a-z]+:/i.test(ref) &&
        !fs.existsSync(path.resolve(path.dirname(file), ref))
      );
    })
    .map((ref) => {
      return `${path.relative(ROOT, file)} → ${ref}`;
    });
};

describe('soat-design skill references', () => {
  test('every local src/href in a specimen card resolves', () => {
    assert.deepEqual(listHtml(DESIGN_DIR).flatMap(unresolvedReferences), []);
  });

  test('the component bundle is built from the current components', async () => {
    assert.ok(
      fs.existsSync(DESIGN_BUNDLE),
      'run `pnpm run design-bundle` to generate _ds_bundle.js'
    );

    assert.equal(
      fs.readFileSync(DESIGN_BUNDLE, 'utf-8'),
      await buildDesignBundle(),
      '_ds_bundle.js is stale: run `pnpm run design-bundle`'
    );
  });
});

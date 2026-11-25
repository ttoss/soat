import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const routesDir = fileURLToPath(
  new URL('../../packages/server/src/rest/v1/', import.meta.url)
);

/** Where `shownBy` is declared or passed through, not stated. */
const PASS_THROUGH =
  /^shownBy:\s*(args|config)\.shownBy\b|^shownBy,|^shownBy:\s*readonly string\[\];/;
const DERIVED_CONST = /const (\w+) = readsShowing\(/g;

test('every shownBy a route states is derived by readsShowing', () => {
  const offenders = [];
  for (const file of fs.readdirSync(routesDir)) {
    if (!file.endsWith('.ts')) continue;
    const source = stripComments(
      fs.readFileSync(path.join(routesDir, file), 'utf-8')
    );
    const derived = new Set(
      [...source.matchAll(DERIVED_CONST)].map((match) => {
        return match[1];
      })
    );
    for (const match of source.matchAll(/\bshownBy\b[^\n]*/g)) {
      const site = match[0].trim();
      if (!site.startsWith('shownBy:') && !site.startsWith('shownBy,')) {
        continue;
      }
      if (PASS_THROUGH.test(site)) continue;
      if (/^shownBy:\s*readsShowing\(/.test(site)) continue;
      const named = /^shownBy:\s*(\w+),?$/.exec(site);
      if (named && derived.has(named[1])) continue;
      offenders.push(`${file}: ${site}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'Derive shownBy with readsShowing (src/lib/permissionCatalog.ts), never a hand-written list'
  );
});

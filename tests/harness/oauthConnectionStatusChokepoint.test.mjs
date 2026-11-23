import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');
const CHOKEPOINT = 'lib/oauthConnectionStatus.ts';

// Each move to `connected` or `disconnected` announces an
// `oauth_connections.*` event; a write elsewhere would move it silently.
test(`only ${CHOKEPOINT} writes a connection's connected or disconnected status`, () => {
  const write = /status:\s*'(connected|disconnected)'/;
  const offenders = fs
    .readdirSync(srcDir, { recursive: true })
    .filter((entry) => {
      return entry.endsWith('.ts') && entry !== CHOKEPOINT;
    })
    .filter((entry) => {
      return write.test(
        stripComments(fs.readFileSync(path.join(srcDir, entry), 'utf-8'))
      );
    });

  assert.deepEqual(offenders, []);
});

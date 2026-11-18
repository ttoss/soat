import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/** A call that sends a request out of the process, or into the API in it. */
const REQUEST_SITE = /\b(fetch|fetchWithEgressGuard|dispatchApiRequest)\(/;

const CARRIES = 'carries';

/**
 * Every file that sends a request, and whether that request can cause a write
 * back into the API on the sender's behalf. One that can carries the causal
 * chain through `withOutboundToolHeaders` (`lib/causationHeader.ts`); every
 * other one states why it cannot. A file missing here fails.
 */
const REQUEST_SITES = {
  'lib/agentToolResolver.ts': CARRIES,
  'lib/mcpTransport.ts': CARRIES,
  'lib/formationHandlerClient.ts': CARRIES,
  'lib/inProcessApi.ts':
    'in process: the request runs in the caller’s async context and inherits its chain',
  'lib/toolEgress.ts':
    'the guard every carrier sends through; the carrier adds the header',
  'lib/egressFetch.ts': 'AI provider requests: a model answers, never writes',
  'lib/admission.ts': 'the admission service answers allow or refuse',
  'lib/oauthTokenEndpoint.ts': 'an OAuth token exchange',
  'lib/toolAuthGcp.ts': 'a credential exchange for a tool’s auth',
  'lib/docs.ts': 'reads published docs',
  'lib/webhookDispatcher.ts':
    'an external receiver: loops through it are outside the guard (triggers.md)',
};

/** Source with comments dropped, so prose naming a call is not a hit. */
const code = (file) => {
  return stripComments(fs.readFileSync(file, 'utf-8'));
};

const tsFiles = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
};

const requestSites = () => {
  return tsFiles(srcDir)
    .filter((file) => {
      return REQUEST_SITE.test(code(file));
    })
    .map((file) => {
      return path.relative(srcDir, file);
    })
    .sort();
};

describe('causal chain across self-calls', () => {
  test('every file sending a request is classified', () => {
    assert.deepEqual(requestSites(), Object.keys(REQUEST_SITES).sort());
  });

  test('a site whose request can write back carries the chain', () => {
    const missing = Object.entries(REQUEST_SITES)
      .filter(([file, answer]) => {
        return (
          answer === CARRIES &&
          !code(path.join(srcDir, file)).includes('withOutboundToolHeaders(')
        );
      })
      .map(([file]) => {
        return file;
      });
    assert.deepEqual(missing, []);
  });

  test('only the causation middleware restores a chain from a request', () => {
    const readers = tsFiles(srcDir)
      .filter((file) => {
        return code(file).includes('runWithRequestCausation(');
      })
      .map((file) => {
        return path.relative(srcDir, file);
      });
    assert.deepEqual(readers, ['middleware/causation.ts']);
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Turning an OpenAPI operation into an MCP tool — its input schema, argument
 * names, `nullable` handling, `$ref` resolution, request builders — is
 * `@ttoss/http-server-mcp-openapi`'s job. A second implementation here drifts
 * from it, and the drift shows up as a tool that advertises one contract while
 * the API enforces another. SOAT adds only its own metadata (`soatTools.ts`).
 */

const serverSrc = fileURLToPath(
  new URL('../../packages/server/src', import.meta.url)
);

/** Names that only an OpenAPI → MCP implementation defines. */
const DERIVATION_DEFINITIONS =
  /(?:const|function)\s+(buildInputSchema|buildTypedProperty|extractBodyProps|extractPathParams|extractQueryParams|buildPathFn|buildQueryFn|buildBodyFn|dereferenceSchema|normalizeSubschema|operationIdToToolName|getJsonSchemaType)\b/;

const sourceFiles = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
};

describe('MCP tool derivation', () => {
  test('lives in @ttoss/http-server-mcp-openapi, not in the server', () => {
    const files = sourceFiles(serverSrc);
    assert.ok(files.length > 0);

    const offenders = files
      .map((file) => {
        const match = fs
          .readFileSync(file, 'utf8')
          .match(DERIVATION_DEFINITIONS);
        return match ? `${path.relative(serverSrc, file)}: ${match[1]}` : null;
      })
      .filter(Boolean);

    assert.deepEqual(offenders, []);
  });

  test('soatTools derives through the library', () => {
    const soatTools = fs.readFileSync(
      path.join(serverSrc, 'lib/soatTools.ts'),
      'utf8'
    );
    assert.match(soatTools, /openApiToToolDefinitions\(/);
  });
});

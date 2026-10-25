import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A route that loads a resource by id and authorizes against the project it
 * found refuses through `resourceRefusal`, never a bare `FORBIDDEN`. The bare
 * form answers `403` for a resource in a project the caller cannot reach and
 * `404` for an id that names nothing, which tells anyone holding a credential
 * which ids exist in other tenants.
 *
 * Static because every success path is unchanged: a route that reintroduces
 * the bare form passes its own tests unless one of them addresses a resource
 * across a project boundary. `crossProjectById.test.ts` pins the behavior.
 */

const V1_DIR = join(__dirname, '../../../../src/rest/v1');

/** How far above a refusal the authorization naming the project may sit. */
const WINDOW = 16;

test('a by-id refusal goes through resourceRefusal', () => {
  const offenders: string[] = [];

  for (const entry of readdirSync(V1_DIR)) {
    if (!entry.endsWith('.ts')) continue;

    const lines = readFileSync(join(V1_DIR, entry), 'utf-8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (!line.includes("new DomainError('FORBIDDEN'")) continue;

      const above = lines.slice(Math.max(0, index - WINDOW), index);
      // A project read off a loaded resource (`tool.project_id`) rather than
      // one the caller named in the request body.
      const fromLoadedResource = above.some((candidate) => {
        return /projectPublicId: (?!body\.)[\w.]+\.project_id!?,/.test(
          candidate
        );
      });
      if (fromLoadedResource) offenders.push(`${entry}:${index + 1}`);
    }
  }

  expect(offenders).toEqual([]);
});

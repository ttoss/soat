import * as fs from 'node:fs';
import * as path from 'node:path';

import { AI_PROVIDER_SLUGS } from '@soat/postgresdb';
import { load } from 'js-yaml';

/**
 * Drift guardrail — pure validation with no REST entry point.
 *
 * The set of AI provider slugs is written down three times: the Postgres enum
 * (`AI_PROVIDER_SLUGS`), the `provider` enum repeated once per operation in
 * ai-providers.yaml, and the `PROVIDER_BUILDERS` map in `src/lib/agentModel.ts`.
 * The spec enum is what the generated SDK, CLI and MCP surface expose, and the
 * builder map is what actually reaches the model — so a slug added to only one
 * of the three fails in a way no per-operation test catches: the API rejects a
 * slug the database accepts, or accepts one that cannot build a model.
 *
 * `agentModel.ts` is read as source rather than imported because
 * `PROVIDER_BUILDERS` is deliberately private — the module's contract is
 * `buildModel`, and exporting the map only to test it would widen the surface.
 */

const SPEC_PATH = path.resolve(
  __dirname,
  '../../../../src/rest/openapi/v1/ai-providers.yaml'
);
const AGENT_MODEL_PATH = path.resolve(
  __dirname,
  '../../../../src/lib/agentModel.ts'
);

const collectProviderEnums = (node: unknown, out: string[][]): void => {
  if (Array.isArray(node)) {
    for (const item of node) collectProviderEnums(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (
        key === 'provider' &&
        value &&
        typeof value === 'object' &&
        'enum' in value &&
        Array.isArray(value.enum)
      ) {
        const values: unknown[] = value.enum;
        out.push(
          values.filter((v): v is string => {
            return typeof v === 'string';
          })
        );
      }
      collectProviderEnums(value, out);
    }
  }
};

describe('AI provider slug contract', () => {
  test('every provider enum in the spec matches the runtime slugs', () => {
    const spec = load(fs.readFileSync(SPEC_PATH, 'utf8'));
    const enums: string[][] = [];
    collectProviderEnums(spec, enums);

    // Guards the guardrail: if the traversal stops finding the enums (a spec
    // restructure), an empty list would make the assertion below vacuous.
    expect(enums.length).toBeGreaterThanOrEqual(3);
    for (const values of enums) {
      expect(values).toEqual([...AI_PROVIDER_SLUGS]);
    }
  });

  test('every runtime slug has a model builder', () => {
    const source = fs.readFileSync(AGENT_MODEL_PATH, 'utf8');
    const map = source.split('const PROVIDER_BUILDERS')[1];
    expect(map).toBeDefined();
    const body = map.slice(0, map.indexOf('\n};'));

    const missing = AI_PROVIDER_SLUGS.filter((slug) => {
      return !new RegExp(`^\\s{2}${slug}:`, 'm').test(body);
    });
    expect(missing).toEqual([]);
  });
});

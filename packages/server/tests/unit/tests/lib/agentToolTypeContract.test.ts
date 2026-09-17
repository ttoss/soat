import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';
import { AGENT_TOOL_TYPES } from 'src/lib/agentToolResolver';

// Pins `AGENT_TOOL_TYPES` to the enum the OpenAPI spec publishes — the direction
// a typechecker cannot see, since the spec is YAML. Without it, a type added to
// the spec but never to the union is accepted on write and silently dropped on
// read — "the agent ignored my tool" by another road.
//
// A `lib/` test per the keep-list rule: no entry point reports *which* type went
// missing, only an agent that quietly has fewer tools.

const SPEC_PATH = path.resolve(
  __dirname,
  '../../../../src/rest/openapi/v1/tools.yaml'
);

type SchemaWithType = {
  properties?: { type?: { enum?: string[] }; execute?: unknown };
};

const spec = load(fs.readFileSync(SPEC_PATH, 'utf-8')) as {
  components?: { schemas?: Record<string, SchemaWithType> };
};

const schemas = spec.components?.schemas ?? {};

/**
 * The Tool read and write shapes: a `type` enum beside the `execute` config.
 * `type` is a common field name in this file — an `execute.auth` strategy
 * carries its own — and a shape that names one without the other is not a tool.
 */
const schemasDeclaringToolType = Object.entries(schemas).filter(
  ([, schema]) => {
    return (
      Array.isArray(schema.properties?.type?.enum) &&
      schema.properties?.execute !== undefined
    );
  }
);

describe('agent tool type contract', () => {
  test('the spec publishes a tool type enum at all', () => {
    // Guards the tests below from passing vacuously if the enum is ever
    // restructured out of the spec.
    expect(schemasDeclaringToolType.length).toBeGreaterThan(0);
  });

  test.each(schemasDeclaringToolType)(
    '%s publishes exactly the tool types the resolver dispatches',
    (_name, schema) => {
      const declared = [...(schema.properties?.type?.enum ?? [])].sort();
      const dispatched = [...AGENT_TOOL_TYPES].sort();
      expect(declared).toEqual(dispatched);
    }
  );

  test('every dispatched type is a non-empty string', () => {
    for (const toolType of AGENT_TOOL_TYPES) {
      expect(typeof toolType).toBe('string');
      expect(toolType.length).toBeGreaterThan(0);
    }
  });
});

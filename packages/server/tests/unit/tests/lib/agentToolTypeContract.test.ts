import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';
import { AGENT_TOOL_TYPES } from 'src/lib/agentToolResolver';

// ── About this file ─────────────────────────────────────────────────────────
//
// The tool-kind dispatch in `agentToolResolver` used to end in a bare
// `default: return {}` (#1002). A tool whose `type` it did not recognise was
// not an error — it resolved to no tools at all and vanished from the agent's
// tool surface. The generation then ran normally, minus a tool the agent was
// configured with, and nothing anywhere reported it. The symptom reached a user
// as "the agent ignored my tool", several layers away from the cause.
//
// Two halves close that:
//
//   1. `AGENT_TOOL_TYPES` + a `never` guard in the dispatch's `default`, so
//      adding a type to the union without dispatching it is a *type* error.
//   2. This file, which pins that union to the enum the OpenAPI spec publishes
//      — the direction a typechecker cannot see, since the spec is YAML.
//
// Without (2), a type added to the spec (and so to the SDK, the CLI, and the
// MCP tool surface) but never to the union is accepted on write and silently
// dropped on read, which is the original bug arriving by a different road.
//
// Pure comparison of two declarations, so a `lib/` test per the keep-list rule
// in `.claude/rules/tests.md`: there is no entry point that would report *which*
// type went missing, only an agent that quietly has fewer tools.

const SPEC_PATH = path.resolve(
  __dirname,
  '../../../../src/rest/openapi/v1/tools.yaml'
);

type SchemaWithType = {
  properties?: { type?: { enum?: string[] } };
};

const spec = load(fs.readFileSync(SPEC_PATH, 'utf-8')) as {
  components?: { schemas?: Record<string, SchemaWithType> };
};

const schemas = spec.components?.schemas ?? {};

/** Every schema that publishes a `type` enum — the Tool read and write shapes. */
const schemasDeclaringToolType = Object.entries(schemas).filter(
  ([, schema]) => {
    return Array.isArray(schema.properties?.type?.enum);
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

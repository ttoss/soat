import assert from 'node:assert';
import test from 'node:test';

import {
  getMcpTypeLabel,
  type JsonSchema,
  type OpenApiSpec,
} from './openapiReferenceHelpers';

const EMPTY_SPEC: OpenApiSpec = { paths: {} };

const specWithToolBinding = (): OpenApiSpec => {
  return {
    paths: {},
    components: {
      schemas: {
        ToolBinding: { type: 'object' },
      },
    },
  };
};

test('getMcpTypeLabel matches the live MCP server for patch-agent arguments (#775)', () => {
  // max_context_messages: `type: integer, nullable: true` -> server advertises ["number","null"]
  const maxContextMessages: JsonSchema = { type: 'integer', nullable: true };
  assert.equal(
    getMcpTypeLabel({ schema: maxContextMessages, spec: EMPTY_SPEC }),
    'number | null'
  );

  // tool_choice: no `type`, no oneOf/anyOf, nullable -> server advertises no
  // type at all (accepts a string or an object).
  const toolChoice: JsonSchema = { nullable: true };
  assert.equal(
    getMcpTypeLabel({ schema: toolChoice, spec: EMPTY_SPEC }),
    'any | null'
  );

  // tool_bindings: `type: array, nullable: true`, items ref ToolBinding ->
  // server advertises ["array","null"] with object items.
  const spec = specWithToolBinding();
  const toolBindings: JsonSchema = {
    type: 'array',
    nullable: true,
    items: { $ref: '#/components/schemas/ToolBinding' },
  };
  assert.equal(
    getMcpTypeLabel({ schema: toolBindings, spec }),
    'array<object> | null'
  );
});

test('getMcpTypeLabel renders oneOf/anyOf alternatives instead of guessing a single type', () => {
  const oneOfSchema: JsonSchema = {
    oneOf: [{ type: 'string' }, { type: 'object' }],
  };
  assert.equal(
    getMcpTypeLabel({ schema: oneOfSchema, spec: EMPTY_SPEC }),
    'string | object'
  );
});

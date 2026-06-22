import { describe, expect, test } from 'vitest';

import {
  buildRequestBody,
  extractRevealedSecrets,
  getOpRequestSchema,
  initFormData,
} from '@/engine/formHelpers';
import type { ModuleOp, OpenApiSchema } from '@/engine/types';

import { testSpec } from '../fixtures/spec';

describe('getOpRequestSchema', () => {
  test('resolves a $ref request-body schema against the spec', () => {
    const op: ModuleOp = {
      method: 'post',
      pathTemplate: '/api/v1/agents',
      operation: {
        operationId: 'createAgent',
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateAgent' },
            },
          },
        },
      },
    };
    expect(getOpRequestSchema(op, testSpec)?.properties?.name).toBeDefined();
  });

  test('returns undefined when the op has no request body', () => {
    const op: ModuleOp = {
      method: 'get',
      pathTemplate: '/api/v1/agents',
      operation: { operationId: 'listAgents' },
    };
    expect(getOpRequestSchema(op, testSpec)).toBeUndefined();
    expect(getOpRequestSchema(undefined, testSpec)).toBeUndefined();
  });
});

describe('initFormData', () => {
  const schema: OpenApiSchema = {
    type: 'object',
    properties: { name: {}, model: {}, enabled: {} },
  };

  test('seeds every property to empty string with no prefill', () => {
    expect(initFormData(schema, {})).toEqual({
      name: '',
      model: '',
      enabled: '',
    });
  });

  test('stringifies prefill values and ignores null/undefined', () => {
    expect(initFormData(schema, { name: 'Bot', enabled: true })).toEqual({
      name: 'Bot',
      model: '',
      enabled: 'true',
    });
  });

  test('returns an empty object for a schema without properties', () => {
    expect(initFormData(undefined, {})).toEqual({});
  });
});

describe('buildRequestBody', () => {
  const schema: OpenApiSchema = {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      count: { type: 'integer' },
      enabled: { type: 'boolean' },
      meta: { type: 'object' },
    },
  };

  test('omits empty optional fields but keeps required ones', () => {
    const result = buildRequestBody(
      { name: '', count: '', enabled: 'false', meta: '' },
      schema
    );
    expect(result).toEqual({ ok: true, body: { name: '', enabled: false } });
  });

  test('coerces numbers and booleans', () => {
    const result = buildRequestBody(
      { name: 'Bot', count: '7', enabled: 'true' },
      schema
    );
    expect(result).toEqual({
      ok: true,
      body: { name: 'Bot', count: 7, enabled: true },
    });
  });

  test('parses JSON for object/array fields', () => {
    const result = buildRequestBody(
      { name: 'Bot', meta: '{"a":1}' },
      schema
    );
    expect(result.ok && result.body.meta).toEqual({ a: 1 });
  });

  test('returns an error for invalid JSON', () => {
    const result = buildRequestBody({ name: 'Bot', meta: '{bad' }, schema);
    expect(result).toEqual({
      ok: false,
      error: 'Invalid JSON in field "meta"',
    });
  });

  test('treats an empty numeric field as null when required', () => {
    const numericSchema: OpenApiSchema = {
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'integer' } },
    };
    expect(buildRequestBody({ count: '' }, numericSchema)).toEqual({
      ok: true,
      body: { count: null },
    });
  });
});

describe('extractRevealedSecrets', () => {
  test('picks out non-empty string fields whose name marks them sensitive', () => {
    expect(
      extractRevealedSecrets({
        id: 'key_1',
        name: 'CI key',
        key: 'sk_live_abc',
        api_secret: 'shh',
      })
    ).toEqual([
      { key: 'key', value: 'sk_live_abc' },
      { key: 'api_secret', value: 'shh' },
    ]);
  });

  test('ignores empty, masked, or non-string sensitive fields', () => {
    expect(
      extractRevealedSecrets({
        id: 'key_1',
        key: '',
        token_count: 42,
        name: 'plain',
      })
    ).toEqual([]);
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildErrorCatalog,
  buildOpenApiBundle,
  findDanglingRefs,
} from './openApiBundle';

const specA = {
  openapi: '3.0.3',
  info: { title: 'Agents API', version: '1.0.0' },
  tags: [{ name: 'Agents', description: 'Manage AI agents' }],
  paths: {
    '/api/v1/agents': { get: { operationId: 'listAgents', responses: {} } },
  },
  components: {
    schemas: { Agent: { type: 'object' }, Shared: { title: 'from-a' } },
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  },
};

const specWithComponents = {
  openapi: '3.0.3',
  info: { title: 'Orchestrations API', version: '1.0.0' },
  paths: {
    '/api/v1/orchestrations/{orchestration_id}': {
      get: {
        operationId: 'getOrchestration',
        parameters: [{ $ref: '#/components/parameters/orchestration_id' }],
        responses: {
          '200': {
            content: {
              'application/json': {
                // A cross-file reference, as the module specs write it.
                schema: {
                  $ref: './generations.yaml#/components/schemas/Generation',
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
  },
  components: {
    parameters: {
      orchestration_id: {
        name: 'orchestration_id',
        in: 'path',
        required: true,
      },
    },
    responses: { Unauthorized: { description: 'Unauthorized' } },
  },
};

const specWithGeneration = {
  openapi: '3.0.3',
  info: { title: 'Generations API', version: '1.0.0' },
  paths: {},
  components: { schemas: { Generation: { type: 'object' } } },
};

const specB = {
  openapi: '3.0.3',
  info: { title: 'Files API', version: '1.0.0' },
  tags: [{ name: 'Files', description: 'Manage files' }],
  paths: {
    '/api/v1/files': { get: { operationId: 'listFiles', responses: {} } },
  },
  components: {
    schemas: { File: { type: 'object' }, Shared: { title: 'from-b' } },
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  },
};

const errorCodes = {
  RESOURCE_NOT_FOUND: { httpStatus: 404, description: 'Gone missing.' },
  VALIDATION_FAILED: { httpStatus: 400, description: 'Bad body.' },
};

const bundle = () => {
  return buildOpenApiBundle({
    specs: [
      { name: 'agents', spec: specA },
      { name: 'files', spec: specB },
    ],
    version: '0.27.0',
    errorCodes,
  });
};

test('the bundle is a single valid-looking OpenAPI 3 document', () => {
  const merged = bundle();

  assert.equal(merged.openapi, '3.0.3');
  assert.equal(merged.info.version, '0.27.0');
  assert.ok(merged.info.title.length > 0);
  assert.ok(merged.info.description.includes('error'));
  assert.deepEqual(merged.security, [{ bearerAuth: [] }]);
  assert.ok(merged.servers.length > 0);
});

test('every path and schema from every module spec survives the merge', () => {
  const merged = bundle();

  assert.deepEqual(Object.keys(merged.paths).sort(), [
    '/api/v1/agents',
    '/api/v1/files',
  ]);
  for (const name of ['Agent', 'File']) {
    assert.ok(merged.components.schemas[name], `${name} schema`);
  }
  assert.deepEqual(merged.components.securitySchemes, {
    bearerAuth: { type: 'http', scheme: 'bearer' },
  });
});

test('a schema name declared by two modules resolves deterministically', () => {
  // Same rule the server applies in getMergedOpenApiSpec: specs are merged in
  // name order and the last definition wins, so the published bundle matches
  // what a deployment serves at /api/v1/openapi.json.
  assert.deepEqual(bundle().components.schemas.Shared, { title: 'from-b' });
});

test('tags are merged and deduplicated by name', () => {
  const merged = buildOpenApiBundle({
    specs: [
      { name: 'agents', spec: specA },
      { name: 'agents-again', spec: specA },
      { name: 'files', spec: specB },
    ],
    version: '1.0.0',
    errorCodes,
  });

  assert.deepEqual(
    merged.tags.map((tag) => {
      return tag.name;
    }),
    ['Agents', 'Files']
  );
});

test('the bundle documents the error contract agents have to parse', () => {
  const merged = bundle();
  const schema = merged.components.schemas.ErrorResponse;

  assert.ok(schema, 'ErrorResponse schema must be published');
  assert.deepEqual(merged['x-error-codes'].RESOURCE_NOT_FOUND, {
    http_status: 404,
    description: 'Gone missing.',
  });
});

test('an existing ErrorResponse schema from the specs is not overwritten', () => {
  const declared = { type: 'object', title: 'declared-by-the-specs' };
  const merged = buildOpenApiBundle({
    specs: [
      {
        name: 'agents',
        spec: {
          ...specA,
          components: {
            ...specA.components,
            schemas: { ...specA.components.schemas, ErrorResponse: declared },
          },
        },
      },
    ],
    version: '1.0.0',
    errorCodes,
  });

  assert.deepEqual(merged.components.schemas.ErrorResponse, declared);
});

test('the error catalog is a flat, sorted, machine-readable document', () => {
  const catalog = buildErrorCatalog({ errorCodes, version: '0.27.0' });

  assert.equal(catalog.version, '0.27.0');
  assert.match(catalog.shape.example.error.code, /^[A-Z_]+$/);
  assert.deepEqual(
    catalog.codes.map((entry) => {
      return entry.code;
    }),
    ['RESOURCE_NOT_FOUND', 'VALIDATION_FAILED']
  );
  assert.deepEqual(catalog.codes[0], {
    code: 'RESOURCE_NOT_FOUND',
    http_status: 404,
    description: 'Gone missing.',
  });
});

test('every components section survives the merge, not just schemas', () => {
  const merged = buildOpenApiBundle({
    specs: [
      { name: 'generations', spec: specWithGeneration },
      { name: 'orchestrations', spec: specWithComponents },
    ],
    version: '1.0.0',
    errorCodes,
  });

  assert.ok(merged.components.parameters?.orchestration_id, 'parameters');
  assert.ok(merged.components.responses?.Unauthorized, 'responses');
});

test('cross-file refs are rewritten to the bundle-local component', () => {
  const merged = buildOpenApiBundle({
    specs: [
      { name: 'generations', spec: specWithGeneration },
      { name: 'orchestrations', spec: specWithComponents },
    ],
    version: '1.0.0',
    errorCodes,
  });

  assert.match(
    JSON.stringify(merged.paths),
    /"\$ref":"#\/components\/schemas\/Generation"/
  );
  assert.doesNotMatch(JSON.stringify(merged), /generations\.yaml/);
  assert.deepEqual(findDanglingRefs({ bundle: merged }), []);
});

test('a ref with no target in the bundle is reported, not published silently', () => {
  const merged = buildOpenApiBundle({
    specs: [{ name: 'orchestrations', spec: specWithComponents }],
    version: '1.0.0',
    errorCodes,
  });

  assert.deepEqual(findDanglingRefs({ bundle: merged }), [
    '#/components/schemas/Generation',
  ]);
});

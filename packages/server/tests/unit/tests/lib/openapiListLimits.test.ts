import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';

import { AUDIT_LOG_BOUNDS } from '../../../../src/lib/auditLog';
import { LIST_BOUNDS, type PageBounds } from '../../../../src/lib/pagination';

/**
 * Drift guardrail — pure validation with no REST entry point.
 *
 * `limit` and `cursor` are declared once, in `pagination.yaml`, and every list
 * `$ref`s them; a list with other bounds declares its own `limit` inline and is
 * named in {@link OWN_BOUNDS}. Each declaration states the bounds
 * `resolveLimit` applies, which is how an SDK, the CLI and the MCP tools learn
 * them. Any response that is a collection is a `Page` that takes both.
 */

const SPEC_DIR = path.resolve(__dirname, '../../../../src/rest/openapi/v1');

const SHARED = './pagination.yaml#/components/parameters/';
const PAGE_REF = './pagination.yaml#/components/schemas/Page';

/** Lists whose page is not {@link LIST_BOUNDS}. */
const OWN_BOUNDS: Record<string, PageBounds> = {
  listAuditEntries: AUDIT_LOG_BOUNDS,
};

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const listOf = (value: unknown): unknown[] => {
  return Array.isArray(value) ? value : [];
};

const loadSpec = (file: string): unknown => {
  return load(fs.readFileSync(path.join(SPEC_DIR, file), 'utf8'));
};

/** Each operation of a spec with the parameters it takes, path item's included. */
const operationsOf = (spec: unknown) => {
  const paths = isNode(spec) && isNode(spec.paths) ? spec.paths : {};
  return Object.values(paths)
    .filter(isNode)
    .flatMap((item) => {
      return Object.values(item)
        .filter(isNode)
        .flatMap((operation) => {
          const { operationId } = operation;
          if (typeof operationId !== 'string') return [];
          return [
            {
              operationId,
              parameters: [
                ...listOf(item.parameters),
                ...listOf(operation.parameters),
              ],
            },
          ];
        });
    });
};

/** A `limit`/`cursor` query parameter, inline or a `$ref` to the shared one. */
const pagingName = (parameter: unknown): 'limit' | 'cursor' | undefined => {
  if (!isNode(parameter)) return undefined;
  if (typeof parameter.$ref === 'string') {
    if (parameter.$ref === `${SHARED}Limit`) return 'limit';
    if (parameter.$ref === `${SHARED}Cursor`) return 'cursor';
    return undefined;
  }
  if (parameter.in !== 'query') return undefined;
  return parameter.name === 'limit' || parameter.name === 'cursor'
    ? parameter.name
    : undefined;
};

const pagingParameters = () => {
  return fs
    .readdirSync(SPEC_DIR)
    .filter((file) => {
      return file.endsWith('.yaml');
    })
    .sort()
    .flatMap((file) => {
      return operationsOf(loadSpec(file)).flatMap(
        ({ operationId, parameters }) => {
          return parameters.flatMap((parameter) => {
            const name = pagingName(parameter);
            return name ? [{ operationId, name, parameter }] : [];
          });
        }
      );
    });
};

const sharedParameter = (name: 'Limit' | 'Cursor'): unknown => {
  const spec = loadSpec('pagination.yaml');
  const components = isNode(spec) ? spec.components : undefined;
  const parameters = isNode(components) ? components.parameters : undefined;
  return isNode(parameters) ? parameters[name] : undefined;
};

const limitSchema = (bounds: PageBounds) => {
  return {
    type: 'integer',
    minimum: 1,
    maximum: bounds.maxLimit,
    default: bounds.defaultLimit,
  };
};

/** A `$ref`'d schema, resolved within the spec that names it. */
const resolveLocal = (spec: unknown, node: unknown): unknown => {
  if (!isNode(node) || typeof node.$ref !== 'string') return node;
  if (!node.$ref.startsWith('#/')) return node;
  return node.$ref
    .slice(2)
    .split('/')
    .reduce<unknown>((at, key) => {
      return isNode(at) ? at[key] : undefined;
    }, spec);
};

/** `allOf` led by `Page`: the one list envelope. */
const isPage = (spec: unknown, node: unknown): boolean => {
  const resolved = resolveLocal(spec, node);
  if (!isNode(resolved)) return false;
  const [first] = listOf(resolved.allOf);
  return isNode(first) && first.$ref === PAGE_REF;
};

/**
 * Operations answering a collection — a JSON array, a `Page`, or an object
 * whose `data` is an array — with how they page.
 */
const collectionOperations = () => {
  return fs
    .readdirSync(SPEC_DIR)
    .filter((file) => {
      return file.endsWith('.yaml');
    })
    .sort()
    .flatMap((file) => {
      const spec = loadSpec(file);
      const paths = isNode(spec) && isNode(spec.paths) ? spec.paths : {};
      return Object.values(paths)
        .filter(isNode)
        .flatMap((item) => {
          return Object.values(item)
            .filter(isNode)
            .flatMap((operation) => {
              const { operationId, responses } = operation;
              if (typeof operationId !== 'string' || !isNode(responses)) {
                return [];
              }
              const ok = resolveLocal(spec, responses['200']);
              const content = isNode(ok) ? ok.content : undefined;
              const json = isNode(content)
                ? content['application/json']
                : undefined;
              const schema = resolveLocal(
                spec,
                isNode(json) ? json.schema : undefined
              );
              if (!isNode(schema)) return [];
              const properties = isNode(schema.properties)
                ? schema.properties
                : {};
              const data = resolveLocal(spec, properties.data);
              const bareArray = schema.type === 'array';
              const inlineEnvelope = isNode(data) && data.type === 'array';
              // A report may carry its page under one property (`groups`).
              const page =
                isPage(spec, schema) ||
                Object.values(properties).some((property) => {
                  return isPage(spec, property);
                });
              if (!bareArray && !inlineEnvelope && !page) return [];
              const parameters = [
                ...listOf(item.parameters),
                ...listOf(operation.parameters),
              ];
              const names = new Set(parameters.map(pagingName));
              const paged = names.has('limit') && names.has('cursor');
              return [{ operationId, bareArray, inlineEnvelope, paged }];
            });
        });
    });
};

describe('OpenAPI collection responses', () => {
  const operations = collectionOperations();

  test('reads every collection response', () => {
    expect(operations.length).toBeGreaterThan(50);
  });

  test('no collection is a bare array', () => {
    expect(
      operations
        .filter(({ bareArray }) => {
          return bareArray;
        })
        .map(({ operationId }) => {
          return operationId;
        })
    ).toEqual([]);
  });

  test('no collection spells its own envelope', () => {
    expect(
      operations
        .filter(({ inlineEnvelope }) => {
          return inlineEnvelope;
        })
        .map(({ operationId }) => {
          return operationId;
        })
    ).toEqual([]);
  });

  test('every collection takes limit and cursor', () => {
    expect(
      operations
        .filter(({ paged }) => {
          return !paged;
        })
        .map(({ operationId }) => {
          return operationId;
        })
    ).toEqual([]);
  });
});

describe('OpenAPI list pagination', () => {
  const parameters = pagingParameters();

  test('reads the paging parameters of every list', () => {
    expect(parameters.length).toBeGreaterThan(100);
  });

  test('the shared parameters declare the bounds the server applies', () => {
    expect(sharedParameter('Limit')).toMatchObject({
      name: 'limit',
      in: 'query',
      schema: limitSchema(LIST_BOUNDS),
    });
    expect(sharedParameter('Cursor')).toMatchObject({
      name: 'cursor',
      in: 'query',
      schema: { type: 'string' },
    });
  });

  test('every list takes the shared parameters', () => {
    const inline = parameters
      .filter(({ operationId, name, parameter }) => {
        if (isNode(parameter) && typeof parameter.$ref === 'string') {
          return false;
        }
        return !(name === 'limit' && OWN_BOUNDS[operationId]);
      })
      .map(({ operationId, name }) => {
        return `${operationId} ${name}`;
      });
    expect(inline).toEqual([]);
  });

  test.each(Object.entries(OWN_BOUNDS))(
    '%s declares its own bounds',
    (operationId, bounds) => {
      const limit = parameters.find((entry) => {
        return entry.operationId === operationId && entry.name === 'limit';
      });
      expect(limit?.parameter).toMatchObject({ schema: limitSchema(bounds) });
    }
  );
});

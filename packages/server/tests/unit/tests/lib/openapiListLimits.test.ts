import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';

import { AUDIT_LOG_BOUNDS } from '../../../../src/lib/auditLog';
import { LIST_BOUNDS, type PageBounds } from '../../../../src/lib/pagination';

/**
 * Drift guardrail — pure validation with no REST entry point.
 *
 * `limit` and `offset` are declared once, in `pagination.yaml`, and every list
 * `$ref`s them; a list with other bounds declares its own inline and is named
 * in {@link OWN_BOUNDS}. Each declaration states the bounds `resolvePagination`
 * applies, which is how an SDK, the CLI and the MCP tools learn them. Any
 * response that is a collection is an envelope that takes `limit` or `cursor`.
 */

const SPEC_DIR = path.resolve(__dirname, '../../../../src/rest/openapi/v1');

const SHARED = './pagination.yaml#/components/parameters/';

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

/** A `limit`/`offset` query parameter, inline or a `$ref` to the shared one. */
const pagingName = (parameter: unknown): 'limit' | 'offset' | undefined => {
  if (!isNode(parameter)) return undefined;
  if (typeof parameter.$ref === 'string') {
    if (parameter.$ref === `${SHARED}Limit`) return 'limit';
    if (parameter.$ref === `${SHARED}Offset`) return 'offset';
    return undefined;
  }
  if (parameter.in !== 'query') return undefined;
  return parameter.name === 'limit' || parameter.name === 'offset'
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

const sharedParameter = (name: 'Limit' | 'Offset'): unknown => {
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

/**
 * Operations answering a collection — a JSON array, or an object whose `data`
 * is one — with whether they take `limit`.
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
              const data = isNode(schema.properties)
                ? resolveLocal(spec, schema.properties.data)
                : undefined;
              const bareArray = schema.type === 'array';
              const enveloped = isNode(data) && data.type === 'array';
              if (!bareArray && !enveloped) return [];
              const paged = [
                ...listOf(item.parameters),
                ...listOf(operation.parameters),
              ].some((parameter) => {
                return (
                  pagingName(parameter) === 'limit' ||
                  (isNode(parameter) && parameter.name === 'cursor')
                );
              });
              return [{ operationId, bareArray, paged }];
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

  test('every collection takes limit or cursor', () => {
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
    expect(sharedParameter('Offset')).toMatchObject({
      name: 'offset',
      in: 'query',
      schema: { type: 'integer', minimum: 0, default: 0 },
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

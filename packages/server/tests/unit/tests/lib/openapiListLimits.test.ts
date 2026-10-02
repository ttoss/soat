import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';

import {
  AUDIT_LOG_DEFAULT_LIMIT,
  AUDIT_LOG_MAX_LIMIT,
} from '../../../../src/lib/auditLog';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from '../../../../src/lib/pagination';

/**
 * Drift guardrail — pure validation with no REST entry point.
 *
 * Every list clamps `limit` in code (`resolvePagination`, and the audit log's
 * own wider page), so the spec is the only place a caller learns the bounds:
 * an SDK or MCP tool validates against it, and one that advertises no maximum
 * lets a caller ask for a page the server will silently shorten.
 */

const SPEC_DIR = path.resolve(__dirname, '../../../../src/rest/openapi/v1');

/** Lists whose page bounds are not `resolvePagination`'s. */
const OWN_BOUNDS: Record<string, { default: number; maximum: number }> = {
  listAuditEntries: {
    default: AUDIT_LOG_DEFAULT_LIMIT,
    maximum: AUDIT_LOG_MAX_LIMIT,
  },
};

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const listOf = (value: unknown): unknown[] => {
  return Array.isArray(value) ? value : [];
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

/** Every `limit` query parameter, by operation, with its declared schema. */
const limitSchemas = (): Map<string, unknown> => {
  const found = new Map<string, unknown>();
  const files = fs.readdirSync(SPEC_DIR).filter((file) => {
    return file.endsWith('.yaml');
  });
  for (const file of files.sort()) {
    const spec = load(fs.readFileSync(path.join(SPEC_DIR, file), 'utf8'));
    for (const { operationId, parameters } of operationsOf(spec)) {
      const limit = parameters.find((parameter) => {
        return (
          isNode(parameter) &&
          parameter.in === 'query' &&
          parameter.name === 'limit'
        );
      });
      if (isNode(limit)) found.set(operationId, limit.schema);
    }
  }
  return found;
};

describe('OpenAPI list limits', () => {
  const schemas = limitSchemas();

  test('reads the limit of every list', () => {
    expect(schemas.size).toBeGreaterThan(50);
  });

  test('every limit declares the bounds and default the server applies', () => {
    const drifted = [...schemas]
      .filter(([operationId, schema]) => {
        const bounds = OWN_BOUNDS[operationId] ?? {
          default: DEFAULT_LIST_LIMIT,
          maximum: MAX_LIST_LIMIT,
        };
        return (
          !isNode(schema) ||
          schema.type !== 'integer' ||
          schema.minimum !== 1 ||
          schema.maximum !== bounds.maximum ||
          schema.default !== bounds.default
        );
      })
      .map(([operationId, schema]) => {
        return `${operationId}: ${JSON.stringify(schema)}`;
      });
    expect(drifted).toEqual([]);
  });

  test('every list with its own bounds still exists', () => {
    const missing = Object.keys(OWN_BOUNDS).filter((operationId) => {
      return !schemas.has(operationId);
    });
    expect(missing).toEqual([]);
  });
});

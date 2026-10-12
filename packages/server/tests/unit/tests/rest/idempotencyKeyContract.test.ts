import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load } from 'js-yaml';

/**
 * A request's deduplication key has two spellings, the `idempotency_key` body
 * field and the `Idempotency-Key` header, and one reader,
 * `idempotencyKeyOf` (`rest/v1/idempotencyKey.ts`). An operation that accepts
 * the field declares the header, and a route reads the key only through that
 * reader, so a new idempotent route cannot ship one spelling without the other.
 */

const SPECS_DIR = join(__dirname, '../../../../src/rest/openapi/v1');
const V1_DIR = join(__dirname, '../../../../src/rest/v1');
const SHARED_SPEC = 'idempotency.yaml';
const HEADER_REF = `./${SHARED_SPEC}#/components/parameters/IdempotencyKey`;
const READER_FILE = 'idempotencyKey.ts';

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const resolveLocal = (spec: Node, node: unknown): unknown => {
  if (!isNode(node) || typeof node.$ref !== 'string') return node;
  if (!node.$ref.startsWith('#/')) return node;
  return node.$ref
    .slice(2)
    .split('/')
    .reduce<unknown>((at, key) => {
      return isNode(at) ? at[key] : undefined;
    }, spec);
};

const declaresField = (spec: Node, schema: unknown, depth = 0): boolean => {
  const node = resolveLocal(spec, schema);
  if (!isNode(node) || depth > 8) return false;
  if (isNode(node.properties) && 'idempotency_key' in node.properties) {
    return true;
  }
  return ['allOf', 'oneOf', 'anyOf'].some((key) => {
    const members = node[key];
    return (
      Array.isArray(members) &&
      members.some((member) => {
        return declaresField(spec, member, depth + 1);
      })
    );
  });
};

const operations = () => {
  return readdirSync(SPECS_DIR)
    .filter((file) => {
      return file.endsWith('.yaml') && file !== SHARED_SPEC;
    })
    .sort()
    .flatMap((file) => {
      const spec = load(readFileSync(join(SPECS_DIR, file), 'utf-8'));
      if (!isNode(spec) || !isNode(spec.paths)) return [];
      const doc = spec;
      return Object.values(spec.paths).flatMap((pathItem) => {
        if (!isNode(pathItem)) return [];
        return Object.values(pathItem)
          .filter(isNode)
          .filter((operation) => {
            return typeof operation.operationId === 'string';
          })
          .map((operation) => {
            const requestBody = resolveLocal(doc, operation.requestBody);
            const content = isNode(requestBody) ? requestBody.content : null;
            const json = isNode(content) ? content['application/json'] : null;
            const parameters = Array.isArray(operation.parameters)
              ? operation.parameters
              : [];
            return {
              id: `${file} ${String(operation.operationId)}`,
              acceptsField: isNode(json) && declaresField(doc, json.schema),
              declaresHeader: parameters.some((parameter) => {
                return isNode(parameter) && parameter.$ref === HEADER_REF;
              }),
            };
          });
      });
    });
};

describe('Idempotency-Key contract', () => {
  test('some operation accepts idempotency_key', () => {
    expect(
      operations().filter((operation) => {
        return operation.acceptsField;
      }).length
    ).toBeGreaterThan(0);
  });

  test('every operation accepting idempotency_key declares the header', () => {
    const missing = operations()
      .filter((operation) => {
        return operation.acceptsField && !operation.declaresHeader;
      })
      .map((operation) => {
        return operation.id;
      });

    expect(missing).toEqual([]);
  });

  test('only an operation accepting idempotency_key declares the header', () => {
    const stray = operations()
      .filter((operation) => {
        return operation.declaresHeader && !operation.acceptsField;
      })
      .map((operation) => {
        return operation.id;
      });

    expect(stray).toEqual([]);
  });

  test('a route reads the key only through idempotencyKeyOf', () => {
    const readers = readdirSync(V1_DIR)
      .filter((file) => {
        return file.endsWith('.ts') && file !== READER_FILE;
      })
      .filter((file) => {
        return readFileSync(join(V1_DIR, file), 'utf-8').includes(
          'idempotency_key'
        );
      });

    expect(readers).toEqual([]);
  });
});

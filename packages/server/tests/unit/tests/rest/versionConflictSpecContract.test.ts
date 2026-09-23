import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load } from 'js-yaml';

/**
 * Every versioned write can answer `409 VERSION_CONFLICT`: a stated
 * `expected_version` the resource has moved past, or a concurrent write that
 * took the version first. A client generated from the spec only handles the
 * statuses the spec declares, so each one declares it — through the shared
 * `VersionConflict` response, or its own `409` naming the code when the route
 * has other conflicts to describe.
 *
 * A write is versioned when its request body declares `expected_version`, and
 * every version restore is one.
 */

const SPEC_DIR = join(__dirname, '../../../../src/rest/openapi/v1');
const SHARED_RESPONSE =
  './concurrency.yaml#/components/responses/VersionConflict';
const METHODS = ['get', 'put', 'post', 'patch', 'delete'];

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/** Follows a same-file `$ref`; a cross-file one is left as it is. */
const resolveLocal = (args: { spec: Node; value: unknown }): unknown => {
  const { spec, value } = args;
  if (!isNode(value) || typeof value.$ref !== 'string') return value;
  if (!value.$ref.startsWith('#/')) return value;
  let target: unknown = spec;
  for (const key of value.$ref.slice(2).split('/')) {
    target = isNode(target) ? target[key] : undefined;
  }
  return resolveLocal({ spec, value: target });
};

const declaresExpectedVersion = (args: { spec: Node; op: Node }): boolean => {
  const body = resolveLocal({ spec: args.spec, value: args.op.requestBody });
  const content = isNode(body) ? body.content : undefined;
  const json = isNode(content) ? content['application/json'] : undefined;
  const schema = resolveLocal({
    spec: args.spec,
    value: isNode(json) ? json.schema : undefined,
  });
  const properties = isNode(schema) ? schema.properties : undefined;
  return isNode(properties) && 'expected_version' in properties;
};

const declaresVersionConflict = (response: unknown): boolean => {
  if (!isNode(response)) return false;
  if (response.$ref === SHARED_RESPONSE) return true;
  return (
    typeof response.description === 'string' &&
    response.description.includes('VERSION_CONFLICT')
  );
};

const versionedOperations = readdirSync(SPEC_DIR)
  .filter((file) => {
    return file.endsWith('.yaml');
  })
  .flatMap((file) => {
    const spec = load(readFileSync(join(SPEC_DIR, file), 'utf-8'));
    if (!isNode(spec) || !isNode(spec.paths)) return [];
    const paths = spec.paths;
    return Object.values(paths).flatMap((item) => {
      if (!isNode(item)) return [];
      return METHODS.flatMap((method) => {
        const op = item[method];
        if (!isNode(op) || typeof op.operationId !== 'string') return [];
        const versioned =
          declaresExpectedVersion({ spec, op }) ||
          /^restore\w*Version$/.test(op.operationId);
        if (!versioned) return [];
        const responses = isNode(op.responses) ? op.responses : {};
        return [
          { operationId: op.operationId, conflict: responses['409'] } as const,
        ];
      });
    });
  });

describe('version conflict spec contract', () => {
  test('finds the versioned writes', () => {
    expect(versionedOperations.length).toBeGreaterThanOrEqual(14);
  });

  test('every versioned write declares 409 VERSION_CONFLICT', () => {
    const undeclared = versionedOperations
      .filter((op) => {
        return !declaresVersionConflict(op.conflict);
      })
      .map((op) => {
        return op.operationId;
      })
      .sort();

    expect(undeclared).toEqual([]);
  });

  test('the shared response is the one in concurrency.yaml', () => {
    const concurrency = load(
      readFileSync(join(SPEC_DIR, 'concurrency.yaml'), 'utf-8')
    );
    const components = isNode(concurrency) ? concurrency.components : undefined;
    const responses = isNode(components) ? components.responses : undefined;
    expect(isNode(responses) && isNode(responses.VersionConflict)).toBe(true);
  });
});

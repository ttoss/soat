import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load } from 'js-yaml';

/**
 * Every 4xx/5xx a route declares carries the body it answers with. A client
 * generated from the spec types an error from its declared schema, so a status
 * with no `application/json` schema leaves `error.code` untyped for every
 * caller of that operation.
 *
 * Every authenticated operation can answer `401` (no credential) and `400`
 * (`strictFieldsMiddleware` refuses an unknown query parameter on every
 * documented route, and an unknown body field on every write), so each one
 * declares both. Every operation, public ones included, can answer `500`
 * (`errorLogger`'s catch-all), so each one declares it.
 *
 * Keys are read as YAML 1.1 too: a generator on that version reads an unquoted
 * `on`, `off`, `yes` or `no` key as a boolean, so the property it names
 * disappears from the generated type.
 */

const SPEC_DIR = join(__dirname, '../../../../src/rest/openapi/v1');
const METHODS = ['get', 'put', 'post', 'patch', 'delete'];
const YAML_11_BOOLEAN_KEY =
  /^\s*(?:- )?(?:y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|true|True|TRUE|false|False|FALSE):(?:\s|$)/;

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const files = readdirSync(SPEC_DIR).filter((file) => {
  return file.endsWith('.yaml');
});

const sources = new Map(
  files.map((file) => {
    return [file, readFileSync(join(SPEC_DIR, file), 'utf-8')] as const;
  })
);

const specs = new Map(
  [...sources].map(([file, source]) => {
    return [file, load(source)] as const;
  })
);

/** Follows a `$ref`, same-file or `./other.yaml#/...`, to the node it names. */
const resolve = (args: { file: string; value: unknown }): unknown => {
  const { file, value } = args;
  if (!isNode(value) || typeof value.$ref !== 'string') return value;
  const [target, pointer = ''] = value.$ref.split('#');
  const targetFile = target ? target.replace(/^\.\//, '') : file;
  let node: unknown = specs.get(targetFile);
  for (const key of pointer.split('/').filter(Boolean)) {
    node = isNode(node) ? node[key] : undefined;
  }
  return resolve({ file: targetFile, value: node });
};

const errorResponses = [...specs].flatMap(([file, spec]) => {
  if (!isNode(spec) || !isNode(spec.paths)) return [];
  return Object.values(spec.paths).flatMap((item) => {
    if (!isNode(item)) return [];
    return METHODS.flatMap((method) => {
      const op = item[method];
      if (!isNode(op) || !isNode(op.responses)) return [];
      return Object.entries(op.responses)
        .filter(([status]) => {
          return /^[45]\d\d$/.test(status);
        })
        .map(([status, response]) => {
          return {
            name: `${file} ${String(op.operationId)} ${status}`,
            response: resolve({ file, value: response }),
          };
        });
    });
  });
});

const operations = [...specs].flatMap(([file, spec]) => {
  if (!isNode(spec) || !isNode(spec.paths)) return [];
  const specSecurity = spec.security;
  return Object.values(spec.paths).flatMap((item) => {
    if (!isNode(item)) return [];
    return METHODS.flatMap((method) => {
      const op = item[method];
      if (!isNode(op) || !isNode(op.responses)) return [];
      const security = op.security ?? specSecurity;
      const authenticated =
        Array.isArray(security) &&
        security.length > 0 &&
        security.every((requirement) => {
          return isNode(requirement) && Object.keys(requirement).length > 0;
        });
      return [
        {
          name: `${file} ${String(op.operationId)}`,
          authenticated,
          statuses: Object.keys(op.responses),
        },
      ];
    });
  });
});

const declaresErrorSchema = (response: unknown): boolean => {
  const content = isNode(response) ? response.content : undefined;
  const json = isNode(content) ? content['application/json'] : undefined;
  const schema = isNode(json) ? json.schema : undefined;
  return (
    isNode(schema) &&
    typeof schema.$ref === 'string' &&
    schema.$ref.endsWith('ErrorResponse')
  );
};

describe('error response spec contract', () => {
  test('finds the error responses', () => {
    expect(errorResponses.length).toBeGreaterThanOrEqual(1000);
  });

  test('every 4xx/5xx declares an ErrorResponse body', () => {
    const missing = errorResponses
      .filter(({ response }) => {
        return !declaresErrorSchema(response);
      })
      .map(({ name }) => {
        return name;
      })
      .sort();

    expect(missing).toEqual([]);
  });

  test.each([
    { status: '400', scope: 'authenticated' },
    { status: '401', scope: 'authenticated' },
    { status: '500', scope: 'all' },
  ])('every $scope operation declares $status', ({ status, scope }) => {
    const missing = operations
      .filter(({ authenticated, statuses }) => {
        if (scope === 'authenticated' && !authenticated) return false;
        return !statuses.includes(status);
      })
      .map(({ name }) => {
        return name;
      })
      .sort();

    expect(operations.length).toBeGreaterThanOrEqual(300);
    expect(missing).toEqual([]);
  });

  test('no key reads as a boolean under YAML 1.1', () => {
    const booleanKeys = [...sources].flatMap(([file, source]) => {
      return source
        .split('\n')
        .map((line, index) => {
          return { line, number: index + 1 };
        })
        .filter(({ line }) => {
          return YAML_11_BOOLEAN_KEY.test(line);
        })
        .map(({ number }) => {
          return `${file}:${number}`;
        });
    });

    expect(booleanKeys).toEqual([]);
  });
});

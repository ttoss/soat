import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';

/**
 * Drift guardrail — pure validation with no REST entry point.
 *
 * A failure reason has one shape on the wire, `StoredError`
 * (`{ code, message, meta? }`), declared once in `errors.yaml`. A property
 * named `error` or `*_error` that declares its own shape is a second answer to
 * the same question, and a reader can no longer read `error.code` without first
 * checking the type of `error`.
 *
 * A validation refusal lists what is wrong under one `meta` shape,
 * `ValidationProblems`, and a dry-run validate endpoint answers the same items.
 */

const SPEC_DIR = path.resolve(__dirname, '../../../../src/rest/openapi/v1');
const STORED_ERROR_REF = './errors.yaml#/components/schemas/StoredError';
const PROBLEM_REF = './errors.yaml#/components/schemas/ValidationProblem';

/**
 * Properties that carry the name without being a failure reason. Keyed by file
 * and the trail the walk reports.
 */
const EXEMPT = new Map<string, string>([
  [
    'errors.yaml#/components/schemas/ErrorResponse/properties/error',
    'the response envelope itself: StoredError plus hint and docs_url',
  ],
  [
    'oauth.yaml#/components/schemas/OauthErrorResponse/properties/error',
    'RFC 6749 fixes it as a string code',
  ],
  [
    'orchestrations.yaml#/components/schemas/OrchestrationNode/properties/on_item_error',
    'a loop policy enum, not a failure',
  ],
]);

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const loadSpec = (file: string): Node => {
  const spec = load(fs.readFileSync(path.join(SPEC_DIR, file), 'utf-8'));
  if (!isNode(spec)) throw new Error(`${file} is not an object`);
  return spec;
};

const specFiles = fs
  .readdirSync(SPEC_DIR)
  .filter((file) => {
    return file.endsWith('.yaml');
  })
  .sort();

/** The shared schema, as a property names it: bare, or under `allOf`. */
const refsSchema = (args: { schema: unknown; ref: string }): boolean => {
  const { schema, ref } = args;
  if (!isNode(schema)) return false;
  const local = ref.replace('./errors.yaml', '');
  if (schema.$ref === ref || schema.$ref === local) return true;
  return (
    Array.isArray(schema.allOf) &&
    schema.allOf.length === 1 &&
    isNode(schema.allOf[0]) &&
    (schema.allOf[0].$ref === ref || schema.allOf[0].$ref === local)
  );
};

const collectErrorProperties = (args: {
  node: unknown;
  trail: string;
  out: Array<{ at: string; schema: unknown }>;
}): void => {
  const { node, trail, out } = args;
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      collectErrorProperties({ node: item, trail: `${trail}/${index}`, out });
    }
    return;
  }
  if (!isNode(node)) return;
  if (isNode(node.properties)) {
    for (const [name, schema] of Object.entries(node.properties)) {
      if (name === 'error' || name.endsWith('_error')) {
        out.push({ at: `${trail}/properties/${name}`, schema });
      }
    }
  }
  for (const [key, value] of Object.entries(node)) {
    collectErrorProperties({ node: value, trail: `${trail}/${key}`, out });
  }
};

const errorProperties = specFiles.flatMap((file) => {
  const out: Array<{ at: string; schema: unknown }> = [];
  collectErrorProperties({ node: loadSpec(file), trail: '', out });
  return out.map((entry) => {
    return { ...entry, at: `${file}#${entry.at}` };
  });
});

const schemaOf = (args: { file: string; name: string }): Node => {
  const components = loadSpec(args.file).components;
  const schemas = isNode(components) ? components.schemas : undefined;
  const schema = isNode(schemas) ? schemas[args.name] : undefined;
  if (!isNode(schema)) throw new Error(`${args.file} has no ${args.name}`);
  return schema;
};

describe('OpenAPI failure reasons', () => {
  test('the walk finds the error properties', () => {
    expect(errorProperties.length).toBeGreaterThan(10);
  });

  test('every error property refs StoredError', () => {
    const violations = errorProperties
      .filter(({ at, schema }) => {
        return (
          !EXEMPT.has(at) && !refsSchema({ schema, ref: STORED_ERROR_REF })
        );
      })
      .map(({ at }) => {
        return at;
      });

    expect({ violations }).toEqual({ violations: [] });
  });

  test('every exemption still names a property', () => {
    const found = new Set(
      errorProperties.map(({ at }) => {
        return at;
      })
    );
    const stale = [...EXEMPT.keys()].filter((at) => {
      return !found.has(at);
    });

    expect({ stale }).toEqual({ stale: [] });
  });

  test('StoredError is { code, message, meta? }', () => {
    const schema = schemaOf({ file: 'errors.yaml', name: 'StoredError' });

    expect(schema.required).toEqual(['code', 'message']);
    expect(Object.keys(schema.properties as Node).sort()).toEqual([
      'code',
      'message',
      'meta',
    ]);
  });
});

describe('OpenAPI validation problems', () => {
  test('ValidationProblem is { code, path, message }, code UPPER_SNAKE', () => {
    const schema = schemaOf({ file: 'errors.yaml', name: 'ValidationProblem' });
    const properties = schema.properties as Node;

    expect(schema.required).toEqual(['code', 'path', 'message']);
    expect(Object.keys(properties).sort()).toEqual(['code', 'message', 'path']);
    expect((properties.code as Node).pattern).toBe('^[A-Z][A-Z0-9_]*$');
  });

  test.each([
    ['orchestrations.yaml', 'OrchestrationValidationResult', 'problems'],
    ['orchestrations.yaml', 'OrchestrationValidationResult', 'warnings'],
    ['playbooks.yaml', 'PlaybookValidationResult', 'problems'],
  ])('%s %s.%s lists ValidationProblem items', (file, name, property) => {
    const schema = schemaOf({ file, name });
    const list = (schema.properties as Node)[property] as Node;

    expect(refsSchema({ schema: list.items, ref: PROBLEM_REF })).toBe(true);
  });
});

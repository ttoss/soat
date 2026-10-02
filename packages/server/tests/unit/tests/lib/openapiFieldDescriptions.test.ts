import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';

import undescribedFields from '../../fixtures/undescribedSpecFields.json';

/**
 * Drift guardrail — pure validation with no REST entry point.
 *
 * Every argument an MCP tool or SDK method takes is a request-body property, a
 * query parameter or a path parameter of some operation, and its `description`
 * is the only thing a caller reads to fill it in. A field without one reaches
 * an agent as a bare name and a type.
 *
 * `undescribedSpecFields.json` lists the fields that predate this check. It
 * only shrinks: a new undescribed field fails here, and so does an entry whose
 * field has since gained a description or no longer exists.
 */

const SPEC_DIR = path.resolve(__dirname, '../../../../src/rest/openapi/v1');

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const specs = new Map<string, Node>(
  fs
    .readdirSync(SPEC_DIR)
    .filter((file) => {
      return file.endsWith('.yaml');
    })
    .sort()
    .map((file) => {
      return [file, load(fs.readFileSync(path.join(SPEC_DIR, file), 'utf8'))];
    })
    .filter((entry): entry is [string, Node] => {
      return isNode(entry[1]);
    })
);

/** Follows a local or sibling-file `$ref` to its target, once. */
const deref = (args: { node: unknown; file: string }): unknown => {
  const { node, file } = args;
  if (!isNode(node) || typeof node.$ref !== 'string') return node;
  const [target, pointer = ''] = node.$ref.split('#');
  const document = specs.get(target ? path.basename(target) : file);
  return pointer
    .split('/')
    .filter(Boolean)
    .reduce<unknown>((at, key) => {
      return isNode(at) ? at[key] : undefined;
    }, document);
};

const hasDescription = (args: { node: unknown; file: string }): boolean => {
  const { node, file } = args;
  if (!isNode(node)) return false;
  if (typeof node.description === 'string' && node.description.trim()) {
    return true;
  }
  const resolved = deref({ node, file });
  return resolved !== node && hasDescription({ node: resolved, file });
};

/** The top-level properties of a request body, through `allOf` / `oneOf`. */
const bodyProperties = (args: {
  schema: unknown;
  file: string;
}): Array<[string, unknown]> => {
  const schema = deref({ node: args.schema, file: args.file });
  if (!isNode(schema)) return [];
  const members = ['allOf', 'oneOf', 'anyOf'].flatMap((key) => {
    const list = schema[key];
    return Array.isArray(list) ? list : [];
  });
  return [
    ...Object.entries(isNode(schema.properties) ? schema.properties : {}),
    ...members.flatMap((member) => {
      return bodyProperties({ schema: member, file: args.file });
    }),
  ];
};

const operationsOf = (spec: Node) => {
  return Object.values(isNode(spec.paths) ? spec.paths : {})
    .filter(isNode)
    .flatMap((item) => {
      const shared = Array.isArray(item.parameters) ? item.parameters : [];
      return Object.values(item)
        .filter((operation): operation is Node => {
          return isNode(operation) && typeof operation.operationId === 'string';
        })
        .map((operation) => {
          const own = Array.isArray(operation.parameters)
            ? operation.parameters
            : [];
          return { operation, parameters: [...shared, ...own] };
        });
    });
};

type Operation = ReturnType<typeof operationsOf>[number];

/** Each query and path parameter of an operation, with its verdict. */
const parameterFields = (args: {
  file: string;
  entry: Operation;
}): Array<[string, boolean]> => {
  const { file, entry } = args;
  return entry.parameters.flatMap((raw): Array<[string, boolean]> => {
    const parameter = deref({ node: raw, file });
    if (!isNode(parameter)) return [];
    if (parameter.in !== 'query' && parameter.in !== 'path') return [];
    return [
      [
        `${file} ${parameter.in} ${parameter.name} @${entry.operation.operationId}`,
        hasDescription({ node: parameter, file }),
      ],
    ];
  });
};

/** Each top-level property of an operation's JSON body, with its verdict. */
const bodyFields = (args: {
  file: string;
  entry: Operation;
}): Array<[string, boolean]> => {
  const { file, entry } = args;
  const body = entry.operation.requestBody;
  const content = isNode(body) && isNode(body.content) ? body.content : {};
  const json = content['application/json'];
  if (!isNode(json)) return [];
  const owner =
    isNode(json.schema) && typeof json.schema.$ref === 'string'
      ? json.schema.$ref.split('/').pop()
      : entry.operation.operationId;
  return bodyProperties({ schema: json.schema, file }).map(
    ([name, property]) => {
      return [
        `${file} ${owner}.${name}`,
        hasDescription({ node: property, file }),
      ];
    }
  );
};

/**
 * Every field a caller fills in, keyed `<file> <where>`, with its verdict. A
 * body property two operations share is described once for both.
 */
const collectFields = (): Map<string, boolean> => {
  const fields = new Map<string, boolean>();
  for (const [file, spec] of specs) {
    for (const entry of operationsOf(spec)) {
      for (const [key, described] of [
        ...parameterFields({ file, entry }),
        ...bodyFields({ file, entry }),
      ]) {
        fields.set(key, (fields.get(key) ?? false) || described);
      }
    }
  }
  return fields;
};

describe('OpenAPI field descriptions', () => {
  const fields = collectFields();
  const exempt = new Set(undescribedFields);

  test('reads the fields of every spec', () => {
    expect(fields.size).toBeGreaterThan(1000);
  });

  test('every field outside the exemption list has a description', () => {
    const undescribed = [...fields]
      .filter(([key, described]) => {
        return !described && !exempt.has(key);
      })
      .map(([key]) => {
        return key;
      });
    expect(undescribed).toEqual([]);
  });

  test('every exempt field still exists and still lacks a description', () => {
    const stale = [...exempt].filter((key) => {
      return fields.get(key) !== false;
    });
    expect(stale).toEqual([]);
  });
});

import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';

/**
 * Drift guardrail — pure validation with no REST entry point.
 *
 * A resource served by a list route is read through that route, paged, and
 * never embedded as an array in another response: an embedded copy has no
 * page, so it grows with use and is re-read whole on every read of its parent.
 * The listed item schemas are the `data` items of every list operation.
 */

const SPEC_DIR = path.resolve(__dirname, '../../../../src/rest/openapi/v1');

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const specs = new Map<string, unknown>(
  fs
    .readdirSync(SPEC_DIR)
    .filter((file) => {
      return file.endsWith('.yaml');
    })
    .map((file) => {
      return [file, load(fs.readFileSync(path.join(SPEC_DIR, file), 'utf8'))];
    })
);

/** A `$ref` as `file#/pointer`, resolved against the file that names it. */
const refKey = (args: { ref: string; file: string }): string => {
  const [target, pointer] = args.ref.split('#');
  return `${target ? path.basename(target) : args.file}#${pointer}`;
};

const deref = (key: string): unknown => {
  const [file, pointer] = key.split('#');
  return pointer
    .split('/')
    .slice(1)
    .reduce<unknown>((at, part) => {
      return isNode(at) ? at[part.replace(/~1/g, '/')] : undefined;
    }, specs.get(file));
};

/** Follows a node's `$ref`, if any, to the schema and the file it lives in. */
const follow = (args: {
  node: unknown;
  file: string;
}): { node: unknown; file: string; key?: string } => {
  if (!isNode(args.node) || typeof args.node.$ref !== 'string') return args;
  const key = refKey({ ref: args.node.$ref, file: args.file });
  return { node: deref(key), file: key.split('#')[0], key };
};

type Operation = { operationId: string; schema: unknown; file: string };

const jsonResponses = (): Operation[] => {
  return [...specs].flatMap(([file, spec]) => {
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
            return ['200', '201', '202'].flatMap((status) => {
              const response = follow({ node: responses[status], file }).node;
              const content = isNode(response) ? response.content : undefined;
              const json = isNode(content)
                ? content['application/json']
                : undefined;
              return isNode(json)
                ? [{ operationId, schema: json.schema, file }]
                : [];
            });
          });
      });
  });
};

/** The `$ref` key of a list operation's `data` items, if it is one. */
const listedItem = (operation: Operation): string | undefined => {
  const schema = follow({ node: operation.schema, file: operation.file });
  const properties = isNode(schema.node) ? schema.node.properties : undefined;
  const data = isNode(properties) ? properties.data : undefined;
  if (!isNode(data) || data.type !== 'array' || !isNode(data.items)) {
    return undefined;
  }
  return typeof data.items.$ref === 'string'
    ? refKey({ ref: data.items.$ref, file: schema.file })
    : undefined;
};

/**
 * Every array property, at any depth, whose items are a listed schema; the
 * path names where it sits. A list's own `data` is the one place it belongs.
 */
const embedded = (args: {
  node: unknown;
  file: string;
  listed: Set<string>;
  at: string;
  seen: Set<string>;
}): string[] => {
  const { node, file, key } = follow({ node: args.node, file: args.file });
  if (key) {
    if (args.seen.has(key)) return [];
    args.seen.add(key);
  }
  if (!isNode(node)) return [];
  const branches = ['allOf', 'oneOf', 'anyOf'].flatMap((combinator) => {
    const members = node[combinator];
    return Array.isArray(members) ? members : [];
  });
  const properties = isNode(node.properties) ? node.properties : {};
  return [
    ...branches.flatMap((member) => {
      return embedded({ ...args, node: member, file });
    }),
    ...Object.entries(properties).flatMap(([name, property]) => {
      const at = `${args.at}.${name}`;
      const resolved = follow({ node: property, file }).node;
      if (isNode(resolved) && resolved.type === 'array') {
        const items = isNode(resolved.items) ? resolved.items : undefined;
        const itemKey =
          items && typeof items.$ref === 'string'
            ? refKey({ ref: items.$ref, file })
            : undefined;
        if (itemKey && args.listed.has(itemKey) && at !== '.data') {
          return [at];
        }
        return embedded({ ...args, node: items, file, at: `${at}[]` });
      }
      return embedded({ ...args, node: property, file, at });
    }),
  ];
};

describe('OpenAPI embedded collections', () => {
  const operations = jsonResponses();
  const listed = new Set(
    operations.flatMap((operation) => {
      const item = listedItem(operation);
      return item ? [item] : [];
    })
  );

  test('reads the item schema of every list', () => {
    expect(listed.size).toBeGreaterThan(40);
  });

  test('no response embeds a listed resource', () => {
    expect(
      operations.flatMap((operation) => {
        return embedded({
          node: operation.schema,
          file: operation.file,
          listed,
          at: '',
          seen: new Set(),
        }).map((at) => {
          return `${operation.operationId} ${at}`;
        });
      })
    ).toEqual([]);
  });
});

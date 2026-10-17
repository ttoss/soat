import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load } from 'js-yaml';

/**
 * A record's own identity is `id`, and a reference to another record is
 * `<thing>_id`. A field holding the record's own identity under another name —
 * a receipt line's `event_id`, a playbook node's `key` — reads as a reference
 * to something else, so a client joining two responses has to know which
 * spelling each one chose.
 */

const SPECS_DIR = join(__dirname, '../../../../src/rest/openapi/v1');

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const specOf = (file: string): unknown => {
  return load(readFileSync(join(SPECS_DIR, file), 'utf-8'));
};

/** Every object a spec holds, with the path it sits at. */
const eachObject = (args: {
  node: unknown;
  path: string[];
  visit: (object: Record<string, unknown>, path: string) => void;
}): void => {
  const { node, path, visit } = args;
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      eachObject({ node: item, path: [...path, String(index)], visit });
    }
    return;
  }
  if (!isRecord(node)) return;
  visit(node, path.join('.'));
  for (const [key, value] of Object.entries(node)) {
    eachObject({ node: value, path: [...path, key], visit });
  }
};

describe('a record names itself id', () => {
  test('a schema declaring event_id also declares its own id', () => {
    const found: string[] = [];
    const files = readdirSync(SPECS_DIR).filter((file) => {
      return file.endsWith('.yaml');
    });

    for (const file of files) {
      eachObject({
        node: specOf(file),
        path: [],
        visit: (object, path) => {
          const { properties } = object;
          if (!isRecord(properties) || !('event_id' in properties)) return;
          if (!('id' in properties)) found.push(`${file}: ${path}`);
        },
      });
    }

    expect(found).toEqual([]);
  });
});

/**
 * Where a playbook names a node: `id` on the node itself, `node_id` everywhere
 * else, as an orchestration does.
 */
const NODE_NAMES = new Set(['node', 'key']);

/**
 * The `{node}` path parameter keeps its name: a path template's variable is
 * not a field of any record, and the route's URL is the same either way.
 */
const PARAMETER_EXEMPTIONS: ReadonlyMap<string, string> = new Map([
  ['components.parameters.NodeKey', 'the `{node}` path parameter'],
]);

describe('a playbook names a node by id', () => {
  test('no playbook schema property is named node or key', () => {
    const found: string[] = [];

    eachObject({
      node: specOf('playbooks.yaml'),
      path: [],
      visit: (object, path) => {
        const { properties, required } = object;
        if (isRecord(properties)) {
          for (const name of Object.keys(properties)) {
            if (NODE_NAMES.has(name)) found.push(`${path}.properties.${name}`);
          }
        }
        if (Array.isArray(required)) {
          for (const name of required) {
            if (NODE_NAMES.has(name)) found.push(`${path}.required.${name}`);
          }
        }
      },
    });

    expect(found).toEqual([]);
  });

  test('no playbook parameter is named node or key, but the exempted', () => {
    const found: string[] = [];

    eachObject({
      node: specOf('playbooks.yaml'),
      path: [],
      visit: (object, path) => {
        if (typeof object.in !== 'string' || typeof object.name !== 'string') {
          return;
        }
        if (NODE_NAMES.has(object.name) && !PARAMETER_EXEMPTIONS.has(path)) {
          found.push(`${path}: ${object.in} ${object.name}`);
        }
      },
    });

    expect(found).toEqual([]);
  });
});

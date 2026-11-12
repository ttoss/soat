import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A pin is a list filter that also confines the resource's create and by-id
 * operations. It is declared once, as `x-soat-pin: { field, match }` on the
 * list operation's query parameter; every other operation of the resource
 * carries the same-named query parameter, and `rest/v1/resourcePins.ts` is the
 * one place that reads and enforces it.
 */

const serverRoot = fileURLToPath(
  new URL('../../packages/server', import.meta.url)
);
const { load } = createRequire(path.join(serverRoot, 'package.json'))(
  'js-yaml'
);
const specDir = path.join(serverRoot, 'src/rest/openapi/v1');
const srcDir = path.join(serverRoot, 'src');

const CHOKEPOINT = 'rest/v1/resourcePins.ts';
const MATCHES = new Set(['equals', 'path_prefix']);
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];

/**
 * By-id query parameters that share a list filter's name without being a pin:
 * a nested listing pages by its parent's names, a project selector is scoped
 * by IAM, and an export filters what it exports.
 */
const NOT_PINS = new Set([
  'limit',
  'cursor',
  'project_id',
  'exportMemories?tags',
]);

const specs = new Map();
for (const file of fs.readdirSync(specDir).sort()) {
  if (!file.endsWith('.yaml')) continue;
  specs.set(file, load(fs.readFileSync(path.join(specDir, file), 'utf8')));
}

/** Follows a `#/components/<section>/<name>` or `./file.yaml#/…` ref. */
const resolve = (file, node) => {
  if (!node || typeof node.$ref !== 'string') return { file, node };
  const [target, pointer] = node.$ref.split('#');
  const refFile = target ? path.basename(target) : file;
  let resolved = specs.get(refFile);
  for (const key of pointer.split('/').filter(Boolean)) {
    resolved = resolved?.[key];
  }
  return resolve(refFile, resolved);
};

const operations = [];
for (const [file, spec] of specs) {
  for (const [specPath, item] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const parameters = [
        ...(item.parameters ?? []),
        ...(operation.parameters ?? []),
      ].map((parameter) => {
        return resolve(file, parameter).node;
      });
      operations.push({ file, specPath, method, operation, parameters });
    }
  }
}

const queryNames = (op) => {
  const names = new Set();
  for (const parameter of op.parameters) {
    if (parameter?.in === 'query') names.add(parameter.name);
  }
  return names;
};

const jsonBodySchema = (op) => {
  return op.operation.requestBody?.content?.['application/json']?.schema;
};

/** Top-level JSON body property names, through `$ref` and `allOf`/`oneOf`/`anyOf`. */
const bodyProperties = (op) => {
  const names = new Set();
  const pending = [[op.file, jsonBodySchema(op)]];
  while (pending.length > 0) {
    const { file, node: schema } = resolve(...pending.pop());
    if (!schema || typeof schema !== 'object') continue;
    for (const name of Object.keys(schema.properties ?? {})) names.add(name);
    const members = [
      ...(schema.allOf ?? []),
      ...(schema.oneOf ?? []),
      ...(schema.anyOf ?? []),
    ];
    for (const member of members) pending.push([file, member]);
  }
  return names;
};

const label = (op) => {
  return `${op.method.toUpperCase()} ${op.specPath} (${op.operation.operationId})`;
};

const isList = (op) => {
  return op.method === 'get' && !op.specPath.includes('{');
};

/** Every declared pin, with the list operation it is declared on. */
const declarations = [];
for (const op of operations) {
  for (const parameter of op.parameters) {
    if (parameter?.['x-soat-pin'] === undefined) continue;
    declarations.push({ list: op, name: parameter.name, parameter });
  }
}

/** The operations a list's pins confine: its create and its by-id routes. */
const confinedBy = (list) => {
  return operations.filter((op) => {
    if (op.operation['x-iam-action'] === undefined) return false;
    if (op.specPath === list.specPath) return op.method === 'post';
    return op.specPath.startsWith(`${list.specPath}/{`);
  });
};

const isMalformed = ({ list, parameter }) => {
  const pin = parameter['x-soat-pin'];
  return (
    !isList(list) ||
    parameter.in !== 'query' ||
    typeof pin?.field !== 'string' ||
    !MATCHES.has(pin.match) ||
    Object.keys(pin).length !== 2
  );
};

const undeclaredPinsOf = (list) => {
  const declared = new Set();
  for (const d of declarations) if (d.list === list) declared.add(d.name);
  const found = [];
  for (const op of confinedBy(list)) {
    for (const name of queryNames(op)) {
      if (NOT_PINS.has(name)) continue;
      if (NOT_PINS.has(`${op.operation.operationId}?${name}`)) continue;
      if (!queryNames(list).has(name) || declared.has(name)) continue;
      found.push(
        `${label(op)} ?${name} is not declared on ${list.operation.operationId}`
      );
    }
  }
  return found;
};

const sources = () => {
  return fs
    .readdirSync(srcDir, { recursive: true })
    .filter((entry) => {
      return entry.endsWith('.ts');
    })
    .map((entry) => {
      return {
        entry: entry.split(path.sep).join('/'),
        source: fs.readFileSync(path.join(srcDir, entry), 'utf8'),
      };
    });
};

describe('query pins', () => {
  test('each pin is declared on a list operation as { field, match }', () => {
    const malformed = declarations.filter(isMalformed).map(({ list, name }) => {
      return `${label(list)} ?${name}`;
    });
    assert.deepEqual(malformed, []);
  });

  test('every create and by-id operation of a pinned resource carries its pins', () => {
    const missing = [];
    for (const { list, name } of declarations) {
      for (const op of confinedBy(list)) {
        if (queryNames(op).has(name) || bodyProperties(op).has(name)) continue;
        missing.push(`${label(op)} lacks ?${name}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  test('a by-id query parameter named like a list filter is a declared pin', () => {
    assert.deepEqual(operations.filter(isList).flatMap(undeclaredPinsOf), []);
  });

  test('no operation carries a pin whose name is also a body field', () => {
    const pinNames = new Set(
      declarations.map((d) => {
        return d.name;
      })
    );
    const collisions = [];
    for (const op of operations) {
      const body = bodyProperties(op);
      for (const name of queryNames(op)) {
        if (pinNames.has(name) && body.has(name)) {
          collisions.push(`${label(op)} ?${name} collides with its body field`);
        }
      }
    }
    assert.deepEqual(collisions, []);
  });

  test('pins are read only through the chokepoint', () => {
    const readers = sources()
      .filter(({ entry, source }) => {
        return entry !== CHOKEPOINT && /\breadQueryPin\b/.test(source);
      })
      .map(({ entry }) => {
        return entry;
      });
    assert.deepEqual(readers, []);
  });

  test('each pinned resource enforces its declaration in exactly one module', () => {
    const all = sources();
    const lists = new Set(
      declarations.map((d) => {
        return d.list.operation.operationId;
      })
    );
    const unenforced = [...lists].sort().filter((operationId) => {
      const pattern = new RegExp(
        `resourcePins\\(\\{\\s*listOperation:\\s*'${operationId}'`
      );
      let modules = 0;
      for (const { source } of all) if (pattern.test(source)) modules += 1;
      return modules !== 1;
    });
    assert.deepEqual(unenforced, []);
  });

  test('the pins in force are the documented ones', () => {
    const declared = declarations
      .map((d) => {
        return `${d.list.operation.operationId}?${d.name}`;
      })
      .sort();
    assert.deepEqual(declared, [
      'listDocuments?path_prefix',
      'listMemories?actor_id',
      'listMemories?memory_store_id',
      'listPlaybookCases?actor_id',
    ]);
  });
});

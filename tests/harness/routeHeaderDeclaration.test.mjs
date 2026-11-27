import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { mountedRoutes, ROUTE_METHODS } from './iamRouteChecks.mjs';
import { isFunction, lookup } from './sourceBindings.mjs';

/**
 * A request header a route reads is declared `in: header` on its operation:
 * a client generated from the spec, and a gateway relaying only declared
 * parameters, never sends one the spec names only in prose.
 */

const serverRoot = fileURLToPath(
  new URL('../../packages/server', import.meta.url)
);
const { load } = createRequire(path.join(serverRoot, 'package.json'))(
  'js-yaml'
);
const specDir = path.join(serverRoot, 'src/rest/openapi/v1');

/**
 * Functions that hand the whole header bag to a reader outside the routes,
 * with the headers that reader takes.
 */
const WHOLE_BAG_READERS = new Map([['writePreconditionOf', ['If-Match']]]);

const isCtx = (node) => {
  return ts.isIdentifier(node) && node.text === 'ctx';
};

/** `ctx` or `ctx.request`: the receivers a header is read from. */
const isRequest = (node) => {
  return (
    isCtx(node) ||
    (ts.isPropertyAccessExpression(node) &&
      isCtx(node.expression) &&
      ['request', 'req'].includes(node.name.text))
  );
};

const literalName = (file, node) => {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) return lookup(file, node.text, 'consts')?.value;
  return undefined;
};

/** `ctx.get(name)`: the name, `null` when it resolves to none. */
const getRead = (file, node) => {
  return ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'get' &&
    isRequest(node.expression.expression)
    ? (literalName(file, node.arguments[0]) ?? null)
    : undefined;
};

/** `ctx.headers[name]` or `ctx.headers.name`; the bag itself is `null`. */
const bagRead = (file, node) => {
  if (
    !ts.isPropertyAccessExpression(node) ||
    !['headers', 'header'].includes(node.name.text) ||
    !isRequest(node.expression)
  ) {
    return undefined;
  }
  const parent = node.parent;
  if (parent.expression !== node) return null;
  if (ts.isElementAccessExpression(parent)) {
    return literalName(file, parent.argumentExpression) ?? null;
  }
  return ts.isPropertyAccessExpression(parent) ? parent.name.text : null;
};

/**
 * The header a node reads: its name, `null` for a read no name resolves, or
 * `undefined` when it reads none.
 */
const headerRead = (file, node) => {
  return getRead(file, node) ?? bagRead(file, node);
};

/** Headers `node` reads, following the functions it names, across files. */
const headersIn = (args) => {
  const { file, node, name, seen, found, unresolved } = args;
  const record = (read) => {
    if (read === undefined) return;
    if (read !== null) {
      found.add(read.toLowerCase());
      return;
    }
    const whole = WHOLE_BAG_READERS.get(name);
    if (!whole) {
      unresolved.add(`${path.basename(file)} ${name ?? '(handler)'}`);
      return;
    }
    for (const header of whole) found.add(header.toLowerCase());
  };
  const follow = (identifier) => {
    const target = lookup(file, identifier.text, 'functions');
    const key = target && `${target.file}#${identifier.text}`;
    if (!target || !isFunction(target.value) || seen.has(key)) return;
    seen.add(key);
    headersIn({
      ...args,
      file: target.file,
      node: target.value,
      name: identifier.text,
    });
  };
  const visit = (child) => {
    record(headerRead(file, child));
    if (ts.isIdentifier(child)) follow(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
};

const routeReads = () => {
  const unresolved = new Set();
  const reads = mountedRoutes().map(({ key, file, nodes }) => {
    const found = new Set();
    const seen = new Set();
    for (const node of nodes) {
      headersIn({ file, node, seen, found, unresolved });
    }
    return { key, headers: found };
  });
  return { reads, unresolved: [...unresolved].sort() };
};

const specCache = new Map();
const specOf = (file) => {
  if (!specCache.has(file)) {
    specCache.set(
      file,
      load(fs.readFileSync(path.join(specDir, file), 'utf8'))
    );
  }
  return specCache.get(file);
};

/** A parameter, following a `$ref` into its own or a sibling spec. */
const resolveParameter = (file, parameter) => {
  const ref = parameter?.$ref;
  if (typeof ref !== 'string') return parameter;
  const [target, pointer] = ref.split('#');
  const spec = specOf(target ? path.basename(target) : file);
  return pointer
    .split('/')
    .filter(Boolean)
    .reduce((at, key) => {
      return at?.[key];
    }, spec);
};

const isHeader = (parameter) => {
  return parameter?.in === 'header';
};

/** The lower-cased header names an operation, or its path item, declares. */
const operationHeaders = (file, item, op) => {
  return new Set(
    [...(item.parameters ?? []), ...(op.parameters ?? [])]
      .map((parameter) => {
        return resolveParameter(file, parameter);
      })
      .filter(isHeader)
      .map((parameter) => {
        return parameter.name.toLowerCase();
      })
  );
};

/** Each operation's `method /api/v1/...` key and its declared header names. */
const declaredHeaders = () => {
  const operations = new Map();
  for (const file of fs.readdirSync(specDir).sort()) {
    if (!file.endsWith('.yaml')) continue;
    for (const [route, item] of Object.entries(specOf(file)?.paths ?? {})) {
      for (const method of ROUTE_METHODS) {
        const op = item?.[method];
        if (op?.operationId) {
          operations.set(
            `${method} ${route}`,
            operationHeaders(file, item, op)
          );
        }
      }
    }
  }
  return operations;
};

/** `key: header` for each header a route reads that its operation omits. */
const undeclared = (declared, { key, headers }) => {
  const has = declared.get(key) ?? new Set();
  return [...headers]
    .filter((header) => {
      return !has.has(header);
    })
    .map((header) => {
      return `${key}: ${header}`;
    });
};

describe('route header declaration', () => {
  const { reads, unresolved } = routeReads();

  test('the scan finds each way a route reads a header', () => {
    const read = new Set(
      reads.flatMap(({ headers }) => {
        return [...headers];
      })
    );
    assert.deepEqual(
      ['idempotency-key', 'if-match', 'last-event-id'].filter((header) => {
        return !read.has(header);
      }),
      []
    );
  });

  test('every header read names its header', () => {
    assert.deepEqual(unresolved, []);
  });

  test('every header a route reads is declared on its operation', () => {
    const declared = declaredHeaders();
    const missing = reads.flatMap((read) => {
      return undeclared(declared, read);
    });
    assert.deepEqual(missing, []);
  });
});

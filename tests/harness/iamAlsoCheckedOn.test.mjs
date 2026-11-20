import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { INHERIT, ROUTE_METHODS, routeChecks } from './iamRouteChecks.mjs';

/**
 * A route may check its operation's action on more SRN types than
 * `x-iam-resource-type`, each needed for the whole answer; the spec lists the
 * rest in `x-iam-also-checked-on`. The declared set must equal the literal
 * types the route's checks of that action name, read from its source.
 */

const serverRoot = fileURLToPath(
  new URL('../../packages/server', import.meta.url)
);
const { load } = createRequire(path.join(serverRoot, 'package.json'))(
  'js-yaml'
);
const specDir = path.join(serverRoot, 'src/rest/openapi/v1');

/** Routes mounted with no operation in the spec. */
const UNSPECIFIED_ROUTES = new Set([
  'get /api/v1/oauth/consent-info',
  'post /api/v1/oauth/consent',
  'get /api/v1/openapi.json',
]);

/** The parameter and top-level body field names an operation takes. */
const pinnable = (spec, item, op) => {
  const parameters = [...(item.parameters ?? []), ...(op.parameters ?? [])];
  return new Set([
    ...parameters.map((parameter) => {
      const ref = /^#\/components\/parameters\/(\w+)$/.exec(
        parameter.$ref ?? ''
      )?.[1];
      return ref ? spec.components?.parameters?.[ref]?.name : parameter.name;
    }),
    ...Object.keys(
      op.requestBody?.content?.['application/json']?.schema?.properties ?? {}
    ),
  ]);
};

const specOperations = () => {
  const operations = [];
  for (const file of fs.readdirSync(specDir).sort()) {
    if (!file.endsWith('.yaml')) continue;
    const spec = load(fs.readFileSync(path.join(specDir, file), 'utf8'));
    for (const [route, item] of Object.entries(spec?.paths ?? {})) {
      for (const method of ROUTE_METHODS) {
        const op = item?.[method];
        if (!op?.operationId) continue;
        operations.push({
          key: `${method} ${route}`,
          op,
          pins: pinnable(spec, item, op),
        });
      }
    }
  }
  return operations;
};

const entriesOf = (op) => {
  return op['x-iam-also-checked-on'] ?? [];
};

const alsoCheckedOn = (op) => {
  return entriesOf(op).map((entry) => {
    return entry.resource_type;
  });
};

const isEntry = (entry) => {
  return (
    typeof entry?.resource_type === 'string' &&
    Object.keys(entry).every((key) => {
      return key === 'resource_type' || key === 'pinned_by';
    })
  );
};

/** Whether the entries are well formed, each a distinct further type. */
const entriesHold = (op) => {
  const entries = entriesOf(op);
  if (entries.length === 0) return true;
  const types = [op['x-iam-resource-type'], ...alsoCheckedOn(op)];
  return (
    typeof op['x-iam-resource-type'] === 'string' &&
    entries.every(isEntry) &&
    new Set(types).size === types.length
  );
};

const unknownPins = ({ op, pins }) => {
  return entriesOf(op)
    .filter(({ pinned_by: pin }) => {
      return pin !== undefined && !pins.has(pin);
    })
    .map(({ pinned_by: pin }) => {
      return `${op.operationId}: ${pin}`;
    });
};

const namesAction = (op, check) => {
  return check.actions.some((action) => {
    return action === INHERIT || action === op['x-iam-action'];
  });
};

/** The types the route's single-type checks of the operation's action name. */
const checkedTypes = (op, checks) => {
  const types = new Set();
  for (const check of checks) {
    if (check.types.length === 1 && namesAction(op, check)) {
      types.add(check.types[0]);
    }
  }
  return types;
};

const typeMismatch = ({ op, checks }) => {
  const checked = checkedTypes(op, checks);
  const also = alsoCheckedOn(op);
  const declared = new Set([op['x-iam-resource-type'], ...also]);
  const undeclared = [...checked].filter((type) => {
    return !declared.has(type);
  });
  const unchecked = also.filter((type) => {
    return !checked.has(type);
  });
  return undeclared.length > 0 || unchecked.length > 0
    ? [`${op.operationId}: undeclared [${undeclared}] unchecked [${unchecked}]`]
    : [];
};

describe('x-iam-also-checked-on', () => {
  const operations = specOperations();
  const governed = operations.filter(({ op }) => {
    return typeof op['x-iam-action'] === 'string';
  });
  const routes = routeChecks();

  test('reads operations and routes from disk', () => {
    assert.ok(governed.length > 300);
    assert.ok(routes.size > 300);
  });

  test('every route is read here, and is an operation of the spec', () => {
    const keys = new Set(
      operations.map(({ key }) => {
        return key;
      })
    );
    const unread = governed
      .filter(({ key }) => {
        return !routes.has(key);
      })
      .map(({ key }) => {
        return key;
      });
    const unspecified = [...routes.keys()].filter((key) => {
      return !keys.has(key) && !UNSPECIFIED_ROUTES.has(key);
    });

    assert.deepEqual({ unread, unspecified }, { unread: [], unspecified: [] });
  });

  test('each entry is one further type, with an optional pin', () => {
    const wrong = governed
      .filter(({ op }) => {
        return !entriesHold(op);
      })
      .map(({ op }) => {
        return op.operationId;
      });

    assert.deepEqual(wrong, []);
  });

  test('a pin names a parameter or body field of the operation', () => {
    assert.deepEqual(governed.flatMap(unknownPins), []);
  });

  test("declares each type the route checks the operation's action on, and only those", () => {
    const wrong = governed.flatMap(({ key, op }) => {
      return typeMismatch({ op, checks: routes.get(key) ?? [] });
    });

    assert.deepEqual(wrong, []);
  });
});

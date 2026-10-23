import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const serverRoot = fileURLToPath(
  new URL('../../packages/server/', import.meta.url)
);
const srcDir = path.join(serverRoot, 'src');
const specDir = path.join(srcDir, 'rest/openapi/v1');
const { load } = createRequire(path.join(serverRoot, 'package.json'))(
  'js-yaml'
);

const PAGE_REF = './pagination.yaml#/components/schemas/Page';
const LIMIT_REF = './pagination.yaml#/components/parameters/Limit';
const CURSOR_REF = './pagination.yaml#/components/parameters/Cursor';

const specs = fs
  .readdirSync(specDir)
  .filter((file) => {
    return file.endsWith('.yaml');
  })
  .sort()
  .map((file) => {
    return {
      file,
      spec: load(fs.readFileSync(path.join(specDir, file), 'utf-8')),
    };
  });

/** Source with comments dropped, so prose naming a symbol is not a hit. */
const code = (file) => {
  return fs
    .readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      return !/^\s*\/\//.test(line);
    })
    .join('\n');
};

const sourceFilesMatching = (pattern) => {
  return fs
    .readdirSync(srcDir, { recursive: true })
    .filter((entry) => {
      return (
        entry.endsWith('.ts') && pattern.test(code(path.join(srcDir, entry)))
      );
    })
    .sort();
};

/** Every object schema in a spec, with a path naming where it sits. */
const walk = function* (node, at) {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      yield* walk(item, `${at}[${index}]`);
    }
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  yield { node, at };
  for (const [key, value] of Object.entries(node)) {
    yield* walk(value, `${at}.${key}`);
  }
};

const jsonSchema = (response) => {
  return response?.content?.['application/json']?.schema;
};

const resolve = (schema, components) => {
  return schema?.$ref?.startsWith('#/components/schemas/')
    ? components?.schemas?.[schema.$ref.split('/').pop()]
    : schema;
};

const isPage = (schema, components) => {
  return resolve(schema, components)?.allOf?.[0]?.$ref === PAGE_REF;
};

/**
 * A list `200`: `allOf` led by `Page`, inline or behind one local `$ref` — or
 * one property that is, for a report whose rows are a page of it.
 */
const refsPage = (schema, components) => {
  const resolved = resolve(schema, components);
  return (
    isPage(resolved, components) ||
    Object.values(resolved?.properties ?? {}).some((property) => {
      return isPage(property, components);
    })
  );
};

/** `limit` from `pagination.yaml`, or inline where a list has its own bounds. */
const takesLimit = (operation) => {
  return (operation.parameters ?? []).some((parameter) => {
    return (
      parameter.$ref === LIMIT_REF ||
      (parameter.in === 'query' && parameter.name === 'limit')
    );
  });
};

const listOperations = () => {
  return specs.flatMap(({ file, spec }) => {
    return Object.entries(spec.paths ?? {}).flatMap(([route, item]) => {
      const operation = item.get;
      if (!operation) return [];
      const refs = (operation.parameters ?? []).map((parameter) => {
        return parameter.$ref;
      });
      const paged =
        takesLimit(operation) ||
        refs.includes(CURSOR_REF) ||
        refsPage(jsonSchema(operation.responses?.['200']), spec.components);
      return paged
        ? [{ file, route, operation, refs, components: spec.components }]
        : [];
    });
  });
};

/**
 * A paging parameter or envelope declared outside `pagination.yaml`: an
 * `offset` or `cursor` parameter, or an object holding `next_cursor`, or
 * `data` beside `total`/`offset`.
 */
const isPagingDrift = ({ node, at }) => {
  if (at.startsWith('pagination.yaml')) return false;
  const properties = node.properties ?? {};
  return (
    (node.in === 'query' && ['offset', 'cursor'].includes(node.name)) ||
    node.$ref === './pagination.yaml#/components/parameters/Offset' ||
    'next_cursor' in properties ||
    ('data' in properties && ('total' in properties || 'offset' in properties))
  );
};

/**
 * A list response is one interface, as an error is: `Page` in
 * `pagination.yaml`, `Page<T>` built only by `lib/pagination.ts`. A list that
 * spells its own envelope, takes its own paging parameters or builds its own
 * page answers differently from the rest the day the pattern changes.
 */
describe('pagination chokepoints', () => {
  test('finds the list operations it guards', () => {
    assert.ok(listOperations().length > 60);
  });

  test('every list takes limit and cursor and answers Page', () => {
    const offenders = listOperations()
      .filter(({ refs, operation, components }) => {
        return (
          !takesLimit(operation) ||
          !refs.includes(CURSOR_REF) ||
          !refsPage(jsonSchema(operation.responses?.['200']), components)
        );
      })
      .map(({ file, route }) => {
        return `${file} GET ${route}`;
      });
    assert.deepEqual(offenders, []);
  });

  test('no spec pages by offset, spells its own cursor or reports a total', () => {
    const offenders = specs
      .flatMap(({ file, spec }) => {
        return [...walk(spec, file)];
      })
      .filter(isPagingDrift)
      .map(({ at }) => {
        return at;
      });
    assert.deepEqual(offenders, []);
  });

  test('only lib/pagination.ts writes next_cursor', () => {
    assert.deepEqual(sourceFilesMatching(/\bnext_cursor\b/), [
      'lib/pagination.ts',
    ]);
  });

  test('no list counts its rows', () => {
    assert.deepEqual(sourceFilesMatching(/\bfindAndCountAll\(/), []);
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { mountedRoutes } from './iamRouteChecks.mjs';
import { reachedStrings } from './routeStrings.mjs';
import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');
const formationModulesDir = path.join(srcDir, 'lib/formation-modules');
const specDir = path.join(srcDir, 'rest/openapi/v1');
const { load } = createRequire(
  path.join(repoRoot, 'packages/server/package.json')
)('js-yaml');

const WRITE_METHODS = ['post', 'put', 'patch', 'delete'];
const ADMISSION_REFUSED_REF =
  './errors.yaml#/components/responses/AdmissionRefused';

/** Every operation admission can be declared for, as `METHOD path` → its responses. */
const declarableOperations = () => {
  const operations = [];
  for (const file of fs.readdirSync(specDir)) {
    if (!file.endsWith('.yaml')) continue;
    const spec = load(fs.readFileSync(path.join(specDir, file), 'utf-8'));
    for (const [route, item] of Object.entries(spec.paths ?? {})) {
      for (const method of WRITE_METHODS) {
        const operation = item[method];
        if (!operation?.['x-iam-action']) continue;
        operations.push({ method, route, operation });
      }
    }
  }
  return operations;
};

const declarableWrites = () => {
  return new Map(
    declarableOperations().map(({ method, route, operation }) => {
      return [`${method.toUpperCase()} ${route}`, operation.responses];
    })
  );
};

/** Source with comments dropped, so prose naming a symbol is not a hit. */
const code = (file) => {
  return stripComments(fs.readFileSync(file, 'utf-8'));
};

const sourceFiles = fs
  .readdirSync(srcDir, { recursive: true })
  .filter((entry) => {
    return entry.endsWith('.ts');
  });

/** Value imports of `file`, as `<module relative to src>#<name>`. */
const valueImports = (file) => {
  const imports = [];
  for (const match of code(file).matchAll(
    /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g
  )) {
    const [, names, specifier] = match;
    const module = specifier.startsWith('.')
      ? path.relative(srcDir, path.resolve(path.dirname(file), specifier))
      : specifier.startsWith('src/')
        ? specifier.slice('src/'.length)
        : null;
    if (module === null) continue;
    for (const raw of names.split(',')) {
      const entry = raw.trim();
      if (entry === '' || entry.startsWith('type ')) continue;
      imports.push(`${module}#${entry.split(/\s+as\s+/)[0]}`);
    }
  }
  return imports;
};

/** The lib creates and updates a formation module applies. */
const formationWrites = () => {
  const writes = new Set();
  for (const file of fs.readdirSync(formationModulesDir)) {
    if (!file.endsWith('FormationModule.ts')) continue;
    for (const imported of valueImports(path.join(formationModulesDir, file))) {
      if (/#(create|update)[A-Z]/.test(imported)) writes.add(imported);
    }
  }
  return writes;
};

/** The `writes` `entry` imports, as `entry → write`. */
const callsInto = (args) => {
  const { entry, writes } = args;
  return valueImports(path.join(srcDir, entry))
    .filter((imported) => {
      return writes.has(imported);
    })
    .map((imported) => {
      return `${entry} → ${imported}`;
    });
};

/**
 * Lib modules that call a formation write from inside a REST route's own
 * write, so the route's action is the one admission is asked about.
 */
const REACHED_ONLY_FROM_A_ROUTE = new Set([
  'lib/agentVersions.ts',
  'lib/conversationMessages.ts',
  'lib/deciderVersions.ts',
  'lib/documentVersions.ts',
  'lib/guardrailVersions.ts',
  'lib/orchestrationVersions.ts',
  'lib/playbookVersions.ts',
  'lib/workflowVersions.ts',
]);

/**
 * A declared write is asked about at two chokepoints: the REST middleware
 * (REST and `builtin`) and `defineFormationModule`. A write path reaching a lib
 * create or update around both executes with no question asked.
 */
describe('admission chokepoints', () => {
  test('every declarable write documents the refusal under 4XX and the 502', () => {
    const writes = declarableWrites();
    assert.ok(writes.has('POST /api/v1/agents/{agent_id}/generate'));
    const undocumented = [...writes]
      .filter(([, responses]) => {
        return (
          responses?.['4XX']?.$ref !== ADMISSION_REFUSED_REF ||
          responses?.['502'] === undefined
        );
      })
      .map(([operation]) => {
        return operation;
      });
    assert.deepEqual(undocumented, []);
  });

  test('the REST router mounts the admission middleware', () => {
    assert.match(
      code(path.join(srcDir, 'rest/router.ts')),
      /restRouter\.use\(admissionMiddleware\)/
    );
  });

  // The middleware asks only when the route authorizes under its action, so a
  // route that authenticates and checks nothing executes unasked.
  test('every declarable write authorizes under its declared action', () => {
    const routes = new Map(
      mountedRoutes().map((route) => {
        return [route.key, route];
      })
    );
    const unasked = declarableOperations()
      .filter(({ method, route, operation }) => {
        const mounted = routes.get(`${method} ${route}`);
        return (
          !mounted || !reachedStrings(mounted).has(operation['x-iam-action'])
        );
      })
      .map(({ method, route }) => {
        return `${method.toUpperCase()} ${route}`;
      });
    assert.deepEqual(unasked, []);
  });

  test('defineFormationModule asks before a create and an update', () => {
    const source = code(
      path.join(formationModulesDir, 'defineFormationModule.ts')
    );
    assert.equal(source.match(/await admitWrite\(/g)?.length, 2);
  });

  test('a formation write is called only from a route or a formation module', () => {
    const writes = formationWrites();
    assert.ok(writes.has('lib/triggers#createTrigger'));
    const outside = sourceFiles
      .filter((entry) => {
        return (
          !entry.startsWith('rest/v1/') &&
          !entry.startsWith('lib/formation-modules/') &&
          !REACHED_ONLY_FROM_A_ROUTE.has(entry)
        );
      })
      .flatMap((entry) => {
        return callsInto({ entry, writes });
      });
    assert.deepEqual(outside, []);
  });

  test('every decision recorded as allowed outside isAllowed asks admission', () => {
    const recordsAllowed = sourceFiles.filter((entry) => {
      return /recordAuthorizationDecision\([^)]*allowed(?!: false)/s.test(
        code(path.join(srcDir, entry))
      );
    });
    const withoutAdmission = recordsAllowed.filter((entry) => {
      return !/\badmitAuthorized\(/.test(code(path.join(srcDir, entry)));
    });
    assert.deepEqual(withoutAdmission, []);
  });
});

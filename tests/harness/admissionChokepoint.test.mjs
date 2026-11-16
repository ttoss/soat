import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');
const formationModulesDir = path.join(srcDir, 'lib/formation-modules');

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
  test('the REST router mounts the admission middleware', () => {
    assert.match(
      code(path.join(srcDir, 'rest/router.ts')),
      /restRouter\.use\(admissionMiddleware\)/
    );
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
        return valueImports(path.join(srcDir, entry))
          .filter((imported) => {
            return writes.has(imported);
          })
          .map((imported) => {
            return `${entry} → ${imported}`;
          });
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
    assert.deepEqual(withoutAdmission.sort(), [
      // Records a template resource's action, never the route's own.
      'rest/v1/formations.ts',
    ]);
  });
});

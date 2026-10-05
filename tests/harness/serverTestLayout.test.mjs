import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const serverSrc = path.join(repoRoot, 'packages/server/src');
const testsDir = path.join(repoRoot, 'packages/server/tests/unit/tests');

/**
 * The server's test classes, by what they drive (`.claude/rules/tests.md`):
 * `rest/` an entry point, `jobs/` a background routine no request reaches,
 * `lib/` a pure algorithm or a race HTTP cannot order. A fourth directory is a
 * class nobody defined.
 */
const TEST_CLASSES = ['jobs', 'lib', 'rest'];

/**
 * The processes the server ships: the API, the queue worker and the worker's
 * container healthcheck. A routine is whatever one of them starts and leaves
 * running, so the set is read off their imports rather than listed — a new
 * scheduler wired into `server.ts` joins it without an edit here.
 */
const PROCESS_ENTRIES = ['server.ts', 'worker.ts', 'workerHealthcheck.ts'];

/** `{ a, b as c }` → `['a', 'b']`. */
const importedNames = (clause) => {
  return clause
    .replace(/[{}]/g, '')
    .split(',')
    .map((name) => {
      return name.trim().split(/\s+as\s+/)[0];
    })
    .filter(Boolean);
};

const importsOf = (source) => {
  const imports = [];
  for (const match of source.matchAll(
    /import\s+(?:type\s+)?({[^}]*}|[\w$]+)\s+from\s+'([^']+)'/g
  )) {
    imports.push({ names: importedNames(match[1]), specifier: match[2] });
  }
  return imports;
};

/** `./lib/triggerScheduler` → `lib/triggerScheduler`. */
const entryModule = (specifier) => {
  return path.posix.normalize(specifier).replace(/^\.\//, '');
};

const routineModules = () => {
  const modules = new Set(['lib/scheduler']);
  for (const entry of PROCESS_ENTRIES) {
    const source = fs.readFileSync(path.join(serverSrc, entry), 'utf-8');
    for (const { names, specifier } of importsOf(source)) {
      if (!specifier.startsWith('./lib/')) continue;
      // The healthcheck process exists only to run its import; the API and the
      // worker also import plain helpers, so only what they `start` counts.
      const starts = names.some((name) => {
        return /^start[A-Z]/.test(name);
      });
      if (entry === 'workerHealthcheck.ts' || starts) {
        modules.add(entryModule(specifier));
      }
    }
  }
  return modules;
};

const testFiles = (dir) => {
  return fs.readdirSync(path.join(testsDir, dir)).filter((file) => {
    return file.endsWith('.test.ts');
  });
};

/** The routine modules one `lib/` test imports, as `lib/<file> → src/<module>`. */
const routineImports = (args) => {
  const source = fs.readFileSync(
    path.join(testsDir, 'lib', args.file),
    'utf-8'
  );
  return importsOf(source)
    .map(({ specifier }) => {
      return specifier.replace(/^src\//, '');
    })
    .filter((specifier) => {
      return args.modules.has(specifier);
    })
    .map((specifier) => {
      return `lib/${args.file} → src/${specifier}`;
    });
};

describe('server test layout', () => {
  test('the test directories are exactly the defined classes', () => {
    const dirs = fs
      .readdirSync(testsDir, { withFileTypes: true })
      .filter((entry) => {
        return entry.isDirectory();
      })
      .map((entry) => {
        return entry.name;
      })
      .sort();

    assert.deepEqual(dirs, TEST_CLASSES);
  });

  test('the routine set is read off the process entries', () => {
    const modules = routineModules();

    // A guard against the derivation reading nothing: these two are started by
    // both processes that run routines.
    assert.ok(modules.has('lib/orchestrationScheduler'));
    assert.ok(modules.has('lib/orchestrationWorker'));
  });

  test('a lib test imports no routine module — it belongs in jobs/', () => {
    const modules = routineModules();
    const offenders = testFiles('lib').flatMap((file) => {
      return routineImports({ file, modules });
    });

    assert.deepEqual(offenders, []);
  });
});

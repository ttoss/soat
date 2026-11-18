import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/** Source with comments dropped, so prose naming a symbol is not a hit. */
const code = (file) => {
  return fs
    .readFileSync(path.join(srcDir, file), 'utf-8')
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

const matches = (pattern) => {
  return sourceFiles.flatMap((file) => {
    return [...code(file).matchAll(pattern)].map((match) => {
      return { file, value: match[1] };
    });
  });
};

const systemModules = () => {
  const list = code('lib/filePaths.ts').match(
    /SYSTEM_MODULES = \[([^\]]*)\] as const/
  );
  assert.ok(list, 'lib/filePaths.ts declares SYSTEM_MODULES');
  return [...list[1].matchAll(/'([^']+)'/g)]
    .map((match) => {
      return match[1];
    })
    .sort();
};

/**
 * A module writing under `/.system/` registers how its owner's delete releases
 * what it wrote, so a new writer cannot leave its files behind.
 */
describe('system file release', () => {
  test('every system module registers a release', () => {
    const registry = code('lib/systemFileRelease.ts').match(
      /SYSTEM_FILE_RELEASES = \{([\s\S]*?)\n\} satisfies/
    );
    assert.ok(registry, 'lib/systemFileRelease.ts declares the registry');
    const registered = [...registry[1].matchAll(/^ {2}([a-z-]+): /gm)]
      .map((match) => {
        return match[1];
      })
      .sort();
    assert.deepEqual(registered, systemModules());
  });

  test('systemPath and a document filing take only a registered module', () => {
    assert.match(code('lib/filePaths.ts'), /module: SystemModule;/);
    assert.match(
      code('lib/documentFiling.ts'),
      /DocumentFiling = \{ module: SystemModule;/
    );
  });

  test('every literal module a writer names is registered', () => {
    const named = matches(
      /(?:systemPath\(\{|system: \{)\s*module:\s*([^,\s}]+)/g
    );
    assert.ok(named.length > 0);
    for (const { file, value } of named) {
      if (file === 'lib/documentFiling.ts') continue;
      assert.match(value, /^'[a-z0-9-]+'$/, `${file} names a literal module`);
      assert.ok(
        systemModules().includes(value.slice(1, -1)),
        `${file}: ${value} has no release in SYSTEM_FILE_RELEASES`
      );
    }
  });
});

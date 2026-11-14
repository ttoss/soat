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

/** The body of `export const <name> = {` up to its closing `}`. */
const registryBody = (file, name) => {
  const source = code(file);
  const start = source.indexOf(`export const ${name} = {`);
  return source.slice(start, source.indexOf('\n}', start));
};

const carriers = () => {
  return [
    ...registryBody(
      'lib/resourceGrantCarriers.ts',
      'RESOURCE_GRANT_PRINCIPALS'
    ).matchAll(/^ {2}(\w+): '\w+'/gm),
  ].map((match) => {
    return match[1];
  });
};

const serverFiles = fs
  .readdirSync(srcDir, { recursive: true })
  .filter((entry) => {
    return entry.endsWith('.ts');
  });

/**
 * A resource whose work runs under its own `policy_ids` must carry them on
 * every row, and every path starting its work goes through
 * `resourceWorkAuthority`, which checks what it starts against them.
 */
describe('resource grants', () => {
  test('every resource grant is a writer-rule carrier requiring policies', () => {
    const rule = registryBody('lib/writerRule.ts', 'WRITER_RULE_CARRIERS');
    assert.ok(carriers().length > 0);
    for (const name of carriers()) {
      const start = rule.indexOf(`\n  ${name}: {`);
      assert.notEqual(start, -1, `${name} is not in WRITER_RULE_CARRIERS`);
      const entry = rule.slice(start, rule.indexOf('\n  },', start));
      assert.match(
        entry,
        new RegExp(`policies: '${name}'`),
        `${name} must carry its own policies`
      );
      assert.match(
        entry,
        /policiesRequired:/,
        `${name} must refuse a write without policy_ids`
      );
    }
  });

  test('every resource grant has a work site', () => {
    const sites = serverFiles.map(code).join('\n');
    for (const name of carriers()) {
      assert.match(
        sites,
        new RegExp(`resourceWorkAuthority\\(\\{\\s*carrier: '${name}'`),
        `no work of a ${name} runs under resourceWorkAuthority`
      );
    }
  });

  test('only resourceWorkAuthority builds a resource authority', () => {
    const callers = serverFiles.filter((entry) => {
      return (
        !['lib/workAuthority.ts', 'lib/resourceWork.ts'].includes(entry) &&
        /\bresourceGrantAuthority\b/.test(code(entry))
      );
    });
    assert.deepEqual(callers, []);
  });
});

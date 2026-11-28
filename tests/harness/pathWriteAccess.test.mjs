import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

const CHOKEPOINT = 'rest/v1/pathWriteAccess.ts';

const sources = fs
  .readdirSync(srcDir, { recursive: true })
  .filter((entry) => {
    return entry.endsWith('.ts');
  })
  .map((entry) => {
    return {
      entry,
      source: stripComments(fs.readFileSync(path.join(srcDir, entry), 'utf-8')),
    };
  });

/** The argument text of every `<callee>(...)` call in `source`. */
const callArguments = (source, callee) => {
  const calls = [];
  for (const match of source.matchAll(new RegExp(`\\b${callee}\\(`, 'g'))) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (depth > 0 && end < source.length) {
      if (source[end] === '(') depth += 1;
      if (source[end] === ')') depth -= 1;
      end += 1;
    }
    calls.push(source.slice(match.index + match[0].length, end - 1));
  }
  return calls;
};

/**
 * The path-addressed types, as `pathAddressedResourceTypes` derives them: every
 * `registerResourceFieldMap` call declaring a `pathColumn`.
 */
const pathAddressedTypes = sources.flatMap(({ source }) => {
  return callArguments(source, 'registerResourceFieldMap')
    .filter((args) => {
      return /\bpathColumn\s*:/.test(args);
    })
    .map((args) => {
      return /resourceType:\s*'([^']+)'/.exec(args)?.[1];
    })
    .filter(Boolean);
});

/** A type's IAM module is its plural (`file` → `files:`). */
const isPathAddressedWrite = (args) => {
  return pathAddressedTypes.some((type) => {
    return (
      new RegExp(`resourceType:\\s*'${type}'`).test(args) ||
      new RegExp(`'${type}s:`).test(args)
    );
  });
};

/**
 * A write to a path-addressed type is authorized on the SRN of the path it
 * writes, which only `resolvePathWriteProjectId` computes; a route resolving
 * its project on the type directly would ask on `<type>:*` and refuse a
 * path-scoped grant.
 */
describe('path write access', () => {
  test('the path-addressed types are found', () => {
    assert.ok(pathAddressedTypes.includes('file'));
    assert.ok(pathAddressedTypes.includes('document'));
  });

  test('only the chokepoint resolves a path-addressed write project', () => {
    const offenders = sources
      .filter(({ entry, source }) => {
        return (
          entry !== CHOKEPOINT &&
          callArguments(source, 'resolveWriteProjectId').some(
            isPathAddressedWrite
          )
        );
      })
      .map(({ entry }) => {
        return entry;
      });
    assert.deepEqual(offenders, []);
  });

  test('the chokepoint asks on the written path', () => {
    const { source } = sources.find(({ entry }) => {
      return entry === CHOKEPOINT;
    });
    const [call] = callArguments(source, 'resolveWriteProjectId');
    assert.match(call, /resourceType:\s*args\.resourceType/);
    assert.match(call, /resourceId:[^,]*key\.path/);
    assert.match(
      source,
      /pathAddressedResourceTypes\(\)\.includes\(args\.resourceType\)/
    );
  });
});

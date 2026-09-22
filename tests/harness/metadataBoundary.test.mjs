import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');
const libDir = path.join(srcDir, 'lib');

/**
 * A resource carries two bags with two jobs. `tags` are labels the platform
 * reads: they become the IAM evaluation context on every `isAllowed` call, and
 * a policy condition matches them through `soat:ResourceTag/<key>`. `metadata`
 * is typed JSON the platform stores, validates against a declared schema and
 * filters structurally, and never reads for itself.
 *
 * The line matters because of who writes each bag. A caller who can write
 * `metadata` can write any JSON at all — `system.*` is refused on a tag write
 * and nothing corresponds on the other bag, because nothing there reaches
 * platform state. The day a policy conditions on `metadata`, that caller
 * decides what their own rows match, and the refusal that used to hold is a
 * field they can set.
 *
 * True by construction is not the same as true: these hold the construction.
 */
/** Source with comments dropped, so prose naming the bag is not a hit. */
const code = (file) => {
  return fs
    .readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      return !/^\s*(\/\/|\*)/.test(line);
    })
    .join('\n');
};

const sources = fs
  .readdirSync(srcDir, { recursive: true })
  .filter((entry) => {
    return typeof entry === 'string' && entry.endsWith('.ts');
  })
  .map((entry) => {
    return { file: entry, code: code(path.join(srcDir, entry)) };
  });

/**
 * A call's arguments with every string literal dropped: a resource type, an
 * action or an SRN pattern names the metadata-schemas module itself, which is
 * a resource like any other and not the bag. What survives is the expressions
 * — the fields a call actually reads.
 */
const expressionsIn = (call) => {
  return call.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''");
};

/** The arguments of each `call(` in a source, brace-matched. */
const argumentsOf = (args) => {
  const calls = [];
  let from = 0;
  for (;;) {
    const start = args.code.indexOf(`${args.call}(`, from);
    if (start === -1) return calls;
    let depth = 0;
    let index = start + args.call.length;
    for (; index < args.code.length; index += 1) {
      const char = args.code[index];
      if (char === '(') depth += 1;
      if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(args.code.slice(start, index + 1));
    from = index + 1;
  }
};

/** The files whose `call(` arguments read the metadata bag. */
const callsReading = (call) => {
  return sources
    .flatMap((source) => {
      return argumentsOf({ code: source.code, call }).map((found) => {
        return { file: source.file, call: found };
      });
    })
    .filter((found) => {
      return /metadata/i.test(expressionsIn(found.call));
    })
    .map((found) => {
      return found.file;
    })
    .sort();
};

describe('the metadata boundary', () => {
  /**
   * The three modules that decide access: `iam.ts` evaluates a policy against
   * the context and owns the condition-key vocabulary, `policyCompiler.ts`
   * turns the same policy into the `where` a listing is fenced with, and
   * `tags.ts` builds the context every `isAllowed` call passes. None of them
   * knows the other bag exists.
   */
  test('the modules that decide access never name the bag', () => {
    const naming = ['iam.ts', 'policyCompiler.ts', 'tags.ts'].filter(
      (module) => {
        return /metadata/i.test(code(path.join(libDir, module)));
      }
    );

    assert.deepEqual(naming, []);
  });

  /**
   * `registerResourceFieldMap` is how a module tells the compiler which of its
   * columns a policy may be compiled against. A `metadataColumn` role is the
   * whole boundary in one field, so the registry declares none — and a module
   * cannot pass one, since the field list is closed by the type.
   */
  test('the field-map registry declares no metadata column', () => {
    const declaration = /export type ResourceFieldMap = \{([^}]*)\}/.exec(
      code(path.join(libDir, 'policyCompiler.ts'))
    );

    assert.ok(declaration, 'ResourceFieldMap is declared in policyCompiler.ts');
    assert.equal(/metadata/i.test(declaration[1]), false);
  });

  /**
   * The IAM evaluation context, held from the call side: every `isAllowed`
   * call builds its context from the resource's `tags` — through
   * `buildResourceTagContext`, which reads no other field — so the bag
   * appearing anywhere in those arguments is the other one being wired in.
   */
  test('no authorization call reads the bag', () => {
    assert.deepEqual(callsReading('isAllowed'), []);
  });

  /**
   * The same from the other direction: whatever a policy is compiled against
   * comes through `registerResourceFieldMap`, so a call naming the bag is a
   * column being offered to the compiler.
   */
  test('no module registers the bag as a policy column', () => {
    assert.deepEqual(callsReading('registerResourceFieldMap'), []);
  });
});

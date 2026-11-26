import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const unitDir = path.join(repoRoot, 'packages/server/tests/unit');

/**
 * Waiting on work the request did not finish goes through
 * `fixtures/poll.ts`: one budget, and exhaustion reports the last value read.
 * A loop that sleeps between reads is a local copy of it.
 */
const HELPER = 'fixtures/poll.ts';

/** The suites and their fixtures; the database lifecycle beside them retries on errors, it does not poll. */
const SUITE_DIRS = /^(tests|fixtures)\//;

const LOOPS = new Set([
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
]);

/** `new Promise((resolve) => setTimeout(resolve, n))`: its executor. */
const isPromiseExecutor = (node) => {
  const parent = node.parent;
  return (
    ts.isNewExpression(parent) &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === 'Promise'
  );
};

/** The loop `node` runs in, within its own function; a sleep's executor is transparent. */
const enclosingLoop = (node) => {
  for (let at = node.parent; at; at = at.parent) {
    if (LOOPS.has(at.kind)) return at;
    if (ts.isFunctionLike(at) && !isPromiseExecutor(at)) return undefined;
  }
  return undefined;
};

const calleeName = (call) => {
  return ts.isIdentifier(call.expression) ? call.expression.text : undefined;
};

/** `import { setTimeout as delay } from 'node:timers/promises'` → `['delay']`. */
const timerImports = (node) => {
  if (
    !ts.isImportDeclaration(node) ||
    !/timers\/promises$/.test(node.moduleSpecifier.text)
  ) {
    return [];
  }
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return [];
  return bindings.elements.map((element) => {
    return element.name.text;
  });
};

/** `const sleep = (ms) => new Promise((r) => setTimeout(r, ms))` → `['sleep']`. */
const timerWrappers = (node, sourceFile) => {
  const wraps =
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    ts.isArrowFunction(node.initializer) &&
    /\bsetTimeout\(/.test(node.initializer.getText(sourceFile));
  return wraps ? [node.name.text] : [];
};

/** Names that sleep: `node:timers/promises` imports and local `setTimeout` wrappers. */
const sleepNames = (sourceFile) => {
  const names = new Set(['setTimeout']);
  const visit = (node) => {
    for (const name of [
      ...timerImports(node),
      ...timerWrappers(node, sourceFile),
    ]) {
      names.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
};

/** Line numbers of every sleep a loop runs between reads. */
export const localPollLoops = (args) => {
  const sourceFile = ts.createSourceFile(
    args.file,
    args.source,
    ts.ScriptTarget.Latest,
    true
  );
  const sleeps = sleepNames(sourceFile);
  const lines = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      sleeps.has(calleeName(node)) &&
      enclosingLoop(node)
    ) {
      lines.push(
        sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
};

const testSources = () => {
  return fs
    .readdirSync(unitDir, { recursive: true })
    .map((file) => {
      return file.split(path.sep).join('/');
    })
    .filter((file) => {
      return SUITE_DIRS.test(file) && file.endsWith('.ts');
    })
    .sort();
};

const offendingSites = (file) => {
  const source = fs.readFileSync(path.join(unitDir, file), 'utf-8');
  return localPollLoops({ file, source }).map((line) => {
    return `${file}:${line}`;
  });
};

describe('one poll helper for the server test suites', () => {
  test('the detector flags a sleep in a loop, inline or wrapped', () => {
    const flagged = (source) => {
      return localPollLoops({ file: 'x.ts', source });
    };
    assert.deepEqual(
      flagged('for (;;) { await new Promise((r) => { setTimeout(r, 1); }); }'),
      [1]
    );
    assert.deepEqual(
      flagged(
        'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\nwhile (x) { await sleep(5); }'
      ),
      [2]
    );
    assert.deepEqual(
      flagged(
        "import { setTimeout as delay } from 'node:timers/promises';\ndo { await delay(5); } while (x);"
      ),
      [2]
    );
    assert.deepEqual(
      flagged('await new Promise((r) => setTimeout(r, 5));'),
      []
    );
    assert.deepEqual(
      flagged(
        'for (const c of cases) { test(c, async () => { await new Promise((r) => setTimeout(r, 5)); }); }'
      ),
      []
    );
  });

  test('no test file polls in a loop of its own', () => {
    const offenders = testSources()
      .filter((file) => {
        return file !== HELPER;
      })
      .flatMap(offendingSites);
    assert.deepEqual(
      offenders,
      [],
      `poll through \`${HELPER}\` instead of a local loop`
    );
  });
});

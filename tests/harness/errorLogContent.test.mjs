import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

const CONSOLE_METHODS = new Set(['error', 'warn', 'log', 'info', 'debug']);

/** A name that may hold an error or a payload it quotes. */
const ERROR_TEXT =
  /^(e|err|error|errors|cause|reason|message|msg|body|stack|failure|\w*Error|\w*Msg)$/;

/** A read that yields a fact about the value, never its text. */
const SAFE_PROPERTIES = new Set([
  'code',
  'count',
  'documentId',
  'httpStatus',
  'id',
  'length',
  'MessageId',
  'name',
  'publicId',
  'size',
  'status',
  'statusCode',
  'type',
]);

/** A `debug` logger's call: `log(…)` or `<x>.log(…)` on anything but `console`. */
const isDebugLogCall = (node) => {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'log';
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'log' &&
    !(
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'console'
    )
  );
};

const isConsoleCall = (node) => {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'console' &&
    CONSOLE_METHODS.has(node.expression.name.text)
  );
};

const isLoggableErrorCall = (node) => {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'loggableError'
  );
};

/** A server-written value whose name reads like an error's, and what it holds. */
const SERVER_WRITTEN = new Map([
  ['lib/triggerEventDispatch.ts refusal.reason', "'repeat' | 'depth'"],
]);

/** Whether `node` reads a name that may carry an error's text. */
const readsErrorText = (node, file) => {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (isLoggableErrorCall(child)) return;
    if (SERVER_WRITTEN.has(`${file} ${child.getText()}`)) return;
    // `!x` and `typeof x` read a fact about the value, never its text.
    if (
      (ts.isPrefixUnaryExpression(child) &&
        child.operator === ts.SyntaxKind.ExclamationToken) ||
      ts.isTypeOfExpression(child)
    ) {
      return;
    }
    if (
      ts.isPropertyAccessExpression(child) &&
      SAFE_PROPERTIES.has(child.name.text)
    ) {
      return;
    }
    if (ts.isIdentifier(child) && ERROR_TEXT.test(child.text)) {
      found = true;
      return;
    }
    if (ts.isPropertyAccessExpression(child)) {
      visit(child.expression);
      visit(child.name);
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
};

/**
 * An argument a production log line may carry: a literal, a template whose
 * spans read no error, or an error through `loggableError`.
 */
const isAllowedArgument = (argument, file) => {
  if (isLoggableErrorCall(argument)) return true;
  if (ts.isStringLiteral(argument)) return true;
  if (ts.isNoSubstitutionTemplateLiteral(argument)) return true;
  if (ts.isTemplateExpression(argument)) {
    return argument.templateSpans.every((span) => {
      return !readsErrorText(span.expression, file);
    });
  }
  return !readsErrorText(argument, file);
};

const logCallsReadingErrors = (isLogCall) => {
  const offenders = [];
  const files = fs
    .readdirSync(srcDir, { recursive: true })
    .filter((entry) => {
      return entry.endsWith('.ts');
    });
  for (const entry of files) {
    const source = ts.createSourceFile(
      entry,
      fs.readFileSync(path.join(srcDir, entry), 'utf-8'),
      ts.ScriptTarget.Latest,
      true
    );
    const visit = (node) => {
      const allowed = (argument) => {
        return isAllowedArgument(argument, entry);
      };
      if (isLogCall(node) && !node.arguments.every(allowed)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        offenders.push(`${entry}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return offenders.sort();
};

/**
 * A log line carries only what the server wrote. An error's message can quote
 * a payload another party wrote (a tool target's body, an MCP server's failure,
 * a provider's answer), so every error a production log line writes goes
 * through `loggableError` (`lib/loggableError.ts`).
 */
describe('error log content', () => {
  test('every console line writes an error only through loggableError', () => {
    assert.deepEqual(logCallsReadingErrors(isConsoleCall), []);
  });

  test('every debug line writes an error only through loggableError', () => {
    assert.deepEqual(logCallsReadingErrors(isDebugLogCall), []);
  });

  test('the request error log writes the error through loggableError', () => {
    const source = fs.readFileSync(
      path.join(srcDir, 'middleware/errorLogger.ts'),
      'utf-8'
    );
    assert.match(source, /error: loggableError\(args\.error\)/);
    assert.doesNotMatch(source, /responseBody/);
  });
});

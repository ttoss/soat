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
const ERROR_TEXT = /err|cause|message|body|stack|reason/i;

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

/** Whether `node` reads a name that may carry an error's text. */
const readsErrorText = (node) => {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (ts.isIdentifier(child) && ERROR_TEXT.test(child.text)) {
      found = true;
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
const isAllowedArgument = (argument) => {
  if (isLoggableErrorCall(argument)) return true;
  if (ts.isStringLiteral(argument)) return true;
  if (ts.isNoSubstitutionTemplateLiteral(argument)) return true;
  if (ts.isTemplateExpression(argument)) {
    return argument.templateSpans.every((span) => {
      return !readsErrorText(span.expression);
    });
  }
  return !readsErrorText(argument);
};

const consoleCallsReadingErrors = () => {
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
      if (isConsoleCall(node) && !node.arguments.every(isAllowedArgument)) {
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
    assert.deepEqual(consoleCallsReadingErrors(), []);
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

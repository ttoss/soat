import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { ERROR_CODES } from '../../packages/server/src/errors/codes.ts';
import { mountedRoutes, ROUTE_METHODS } from './iamRouteChecks.mjs';
import { importOf, lookup, parse } from './sourceBindings.mjs';

/**
 * The `DomainError` codes each route's handlers reach, following the
 * functions and values they name across files, and the `x-raises` list
 * each operation declares. `routeErrorDeclaration.test.mjs` holds them equal;
 * `pnpm declare-error-codes` writes the lists. A registry the handlers reach
 * is followed into every entry, so a list may name a code no request raises.
 */

export const DECLARATION = 'x-raises';

const serverRoot = fileURLToPath(
  new URL('../../packages/server', import.meta.url)
);
export const specDir = path.join(serverRoot, 'src/rest/openapi/v1');
const { load } = createRequire(path.join(serverRoot, 'package.json'))(
  'js-yaml'
);

const isCode = (text) => {
  return Object.hasOwn(ERROR_CODES, text);
};

/** The literal codes an expression can take: `'X'`, `a ?? 'X'`, `c ? 'X' : 'Y'`. */
const literalCodes = (file, node) => {
  if (!node) return [];
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) {
    return literalCodes(file, node.expression);
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...literalCodes(file, node.whenTrue),
      ...literalCodes(file, node.whenFalse),
    ];
  }
  if (ts.isBinaryExpression(node)) {
    return [
      ...literalCodes(file, node.left),
      ...literalCodes(file, node.right),
    ];
  }
  if (ts.isIdentifier(node)) {
    const found = lookup(file, node.text, 'consts');
    return found ? [found.value] : [];
  }
  return [];
};

const isDomainError = (node) => {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'DomainError'
  );
};

/**
 * `{ errorCode: 'X' }`, `{ notFoundCode: 'X' }`: a code handed to a raiser,
 * or held by a registry entry a raiser dispatches through.
 */
const handedCode = (node) => {
  return ts.isPropertyAssignment(node) &&
    !ts.isComputedPropertyName(node.name) &&
    /code$/i.test(node.name.text) &&
    ts.isStringLiteralLike(node.initializer) &&
    isCode(node.initializer.text)
    ? node.initializer.text
    : undefined;
};

/** The initializer of `file`'s top-level variable `name`. */
const ownValue = (file, name) => {
  for (const statement of parse(file).statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find((item) => {
      return ts.isIdentifier(item.name) && item.name.text === name;
    });
    if (declaration?.initializer) return declaration.initializer;
  }
  return undefined;
};

/** `name` as `file` sees it: its own variable, else the one it imports. */
const valueOf = (file, name) => {
  const own = ownValue(file, name);
  if (own) return { file, value: own };
  const imported = importOf(file, name);
  const value = imported && ownValue(imported.file, imported.name);
  return value ? { file: imported.file, value } : undefined;
};

const throws = (node) => {
  return ts.isThrowStatement(node) || Boolean(ts.forEachChild(node, throws));
};

const isAsyncCall = (file, node) => {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
    return false;
  }
  const fn = lookup(file, node.expression.text, 'functions')?.value;
  return Boolean(
    fn &&
    ts.getModifiers(fn)?.some((modifier) => {
      return modifier.kind === ts.SyntaxKind.AsyncKeyword;
    })
  );
};

/**
 * A detached call to an async function, `void f(x)` or `f(x).catch(handler)`
 * whose handler never throws: what `f` raises never reaches the caller, but
 * its arguments and the handler run here.
 */
const detachedCall = (file, node) => {
  if (ts.isVoidExpression(node) && isAsyncCall(file, node.expression)) {
    return { call: node.expression, handlers: [] };
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'catch' &&
    isAsyncCall(file, node.expression.expression) &&
    !node.arguments.some(throws)
  ) {
    return { call: node.expression.expression, handlers: node.arguments };
  }
  return undefined;
};

const codesIn = (args) => {
  const { file, node, seen, found } = args;
  // A value is followed into its initializer: `agentAccess.authorizeRead`
  // reaches what `makeItemRouteAuthorizer` builds.
  const follow = (identifier) => {
    const target =
      lookup(file, identifier.text, 'functions') ??
      valueOf(file, identifier.text);
    const key = target && `${target.file}#${identifier.text}`;
    if (!target || seen.has(key)) return;
    seen.add(key);
    codesIn({ ...args, file: target.file, node: target.value });
  };
  const visit = (child) => {
    if (isDomainError(child)) {
      for (const code of literalCodes(file, child.arguments?.[0])) {
        found.add(code);
      }
    }
    const handed = handedCode(child);
    if (handed) found.add(handed);
    if (ts.isIdentifier(child)) follow(child);
    const detached = detachedCall(file, child);
    if (detached) {
      for (const node of [...detached.call.arguments, ...detached.handlers]) {
        visit(node);
      }
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
};

/** Each mounted route's `method /api/v1/...` key and the sorted codes it reaches. */
export const routeErrorCodes = () => {
  return new Map(
    mountedRoutes().map(({ key, file, nodes }) => {
      const found = new Set();
      const seen = new Set();
      for (const node of nodes) codesIn({ file, node, seen, found });
      return [key, [...found].sort()];
    })
  );
};

export const specFiles = () => {
  return fs
    .readdirSync(specDir)
    .filter((file) => {
      return file.endsWith('.yaml');
    })
    .sort();
};

/** Each operation's `method /api/v1/...` key and the codes it declares. */
export const declaredErrorCodes = () => {
  const operations = new Map();
  for (const file of specFiles()) {
    const spec = load(fs.readFileSync(path.join(specDir, file), 'utf8'));
    for (const [route, item] of Object.entries(spec?.paths ?? {})) {
      for (const method of ROUTE_METHODS) {
        const op = item?.[method];
        if (op?.operationId) {
          operations.set(`${method} ${route}`, op[DECLARATION] ?? []);
        }
      }
    }
  }
  return operations;
};

const PATH_LINE = /^ {2}(\/\S*):\s*$/;
const METHOD_LINE = new RegExp(`^ {4}(${ROUTE_METHODS.join('|')}):\\s*$`);
const OPERATION_ID_LINE = /^ {6}operationId: /;
const DECLARATION_LINE = `      ${DECLARATION}:`;
const CODE_LINE = /^ {8}- /;

const declarationLines = (codes = []) => {
  return codes.length === 0
    ? []
    : [
        DECLARATION_LINE,
        ...codes.map((code) => {
          return `        - ${code}`;
        }),
      ];
};

/** The text's lines without any `x-raises` block. */
const undeclared = (text) => {
  const lines = text.split('\n');
  return lines.filter((line, index) => {
    let at = index;
    while (at >= 0 && CODE_LINE.test(lines[at])) at -= 1;
    return line !== DECLARATION_LINE && lines[at] !== DECLARATION_LINE;
  });
};

/**
 * A spec's text with each operation's `x-raises` written after its
 * `operationId`, from `codesOf(key)`; an operation reaching none carries none.
 */
export const declareInSpec = ({ text, codesOf }) => {
  let route;
  let method;
  return undeclared(text)
    .flatMap((line) => {
      route = PATH_LINE.exec(line)?.[1] ?? route;
      method = METHOD_LINE.exec(line)?.[1] ?? method;
      return OPERATION_ID_LINE.test(line)
        ? [line, ...declarationLines(codesOf(`${method} ${route}`))]
        : [line];
    })
    .join('\n');
};

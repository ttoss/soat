import ts from 'typescript';

import { importOf, isFunction, parse } from './sourceBindings.mjs';

/**
 * The strings a route's handlers reach on every path, read by
 * `admissionChokepoint.test.mjs` to find the action each route authorizes
 * under.
 */

/** A declaration worth following for the strings it names. */
const namesStrings = (node) => {
  if (isFunction(node)) return true;
  if (!ts.isVariableDeclaration(node) || !node.initializer) return false;
  let value = node.initializer;
  while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) {
    value = value.expression;
  }
  return (
    isFunction(value) ||
    ts.isStringLiteralLike(value) ||
    ts.isObjectLiteralExpression(value)
  );
};

/** Each function, string or object `file` declares, at any depth: first wins. */
const declarationsCache = new Map();
const declarationsOf = (file) => {
  if (declarationsCache.has(file)) return declarationsCache.get(file);
  const declarations = new Map();
  declarationsCache.set(file, declarations);
  const visit = (node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      !declarations.has(node.name.text) &&
      namesStrings(node)
    ) {
      declarations.set(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return declarations;
};

const declarationOf = (file, name) => {
  const own = declarationsOf(file).get(name);
  if (own) return { file, node: own };
  const imported = importOf(file, name);
  const node = imported && declarationsOf(imported.file).get(imported.name);
  return node ? { file: imported.file, node } : undefined;
};

const intersect = (a, b) => {
  return new Set(
    [...a].filter((value) => {
      return b.has(value);
    })
  );
};

/** Operators whose right operand may never run. */
const SHORT_CIRCUIT = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

const isLoop = (node) => {
  return (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node)
  );
};

/** A choice between two strings (a `read` or `write` action) is a value the call it feeds always uses. */
const isStringChoice = (node) => {
  return (
    ts.isStringLiteralLike(node.whenTrue) &&
    ts.isStringLiteralLike(node.whenFalse)
  );
};

/**
 * A control-flow node's parts: `always` run on every path through it; of
 * `either`, exactly one runs. `null` for a node that is not a branch.
 */
const BRANCHES = [
  [
    ts.isIfStatement,
    (node) => {
      return {
        always: [node.expression],
        either: [node.thenStatement, node.elseStatement ?? null],
      };
    },
  ],
  [
    (node) => {
      return ts.isConditionalExpression(node) && !isStringChoice(node);
    },
    (node) => {
      return {
        always: [node.condition],
        either: [node.whenTrue, node.whenFalse],
      };
    },
  ],
  [
    (node) => {
      return (
        ts.isBinaryExpression(node) &&
        SHORT_CIRCUIT.has(node.operatorToken.kind)
      );
    },
    (node) => {
      return { always: [node.left], either: [] };
    },
  ],
  [
    ts.isSwitchStatement,
    (node) => {
      return { always: [node.expression], either: [] };
    },
  ],
  [
    ts.isTryStatement,
    (node) => {
      return { always: [node.tryBlock, node.finallyBlock], either: [] };
    },
  ],
  [
    isLoop,
    (node) => {
      return {
        always: [node.initializer, node.condition, node.expression],
        either: [],
      };
    },
  ],
];

const branchesOf = (node) => {
  const entry = BRANCHES.find(([matches]) => {
    return matches(node);
  });
  return entry ? entry[1](node) : null;
};

/**
 * The string literals a route's handlers reach on every path, following each
 * name they use to the function, string or object it declares, across files.
 * A string reached only under a branch, a short circuit, a `case`, a `catch`
 * or a loop body is not on every path, so an authorization one branch skips
 * does not count.
 */
export const stringsOnEveryPath = (route) => {
  const cache = new Map();
  const ofDeclaration = (target) => {
    const key = `${target.file}#${target.node.pos}`;
    if (!cache.has(key)) {
      cache.set(key, new Set());
      cache.set(key, ofNode(target.file, target.node));
    }
    return cache.get(key);
  };
  const ofEither = (file, nodes) => {
    if (nodes.length === 0) return new Set();
    return nodes
      .map((node) => {
        return node ? ofNode(file, node) : new Set();
      })
      .reduce(intersect);
  };
  const ofNode = (file, node) => {
    const strings = new Set();
    const add = (set) => {
      for (const value of set) strings.add(value);
    };
    const visit = (child) => {
      const branches = branchesOf(child);
      if (branches) {
        for (const part of branches.always) if (part) visit(part);
        add(ofEither(file, branches.either));
        return;
      }
      if (ts.isStringLiteralLike(child)) strings.add(child.text);
      const target = ts.isIdentifier(child) && declarationOf(file, child.text);
      if (target) add(ofDeclaration(target));
      ts.forEachChild(child, visit);
    };
    visit(node);
    return strings;
  };
  return new Set(
    route.nodes.flatMap((node) => {
      return [...ofNode(route.file, node)];
    })
  );
};

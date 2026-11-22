import ts from 'typescript';

import { importOf, isFunction, parse } from './iamRouteChecks.mjs';

/**
 * The strings a route's handlers reach, read by `admissionChokepoint.test.mjs`
 * to find the action each route authorizes under.
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

/**
 * The string literals a route's handlers reach, following each name they use
 * to the function, string or object it declares, across files.
 */
export const reachedStrings = (route) => {
  const strings = new Set();
  const seen = new Set();
  const walk = (file, node) => {
    const visit = (child) => {
      if (ts.isStringLiteralLike(child)) strings.add(child.text);
      if (ts.isIdentifier(child)) {
        const target = declarationOf(file, child.text);
        const key = target && `${target.file}#${target.node.pos}`;
        if (target && !seen.has(key)) {
          seen.add(key);
          walk(target.file, target.node);
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  };
  for (const node of route.nodes) walk(route.file, node);
  return strings;
};

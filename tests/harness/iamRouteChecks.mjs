import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  isFunction,
  literalProp,
  lookup,
  parse,
  propName,
} from './sourceBindings.mjs';

/**
 * Reads, from a route's source, the authorization checks its handlers reach
 * and the SRN types each names. Read by `iamAlsoCheckedOn.test.mjs`.
 */

const serverRoot = fileURLToPath(
  new URL('../../packages/server', import.meta.url)
);
const routesDir = path.join(serverRoot, 'src/rest/v1');

/** Calls not followed: each is a path taken instead of the route's own check. */
const ALTERNATIVE_PATHS = new Map([
  [
    'authorizeSharedUse',
    "a share grantee's credential checks the shared resource instead of its own project",
  ],
]);

/** Calls naming a `resourceType` without checking it. */
const NOT_CHECKS = new Set(['buildResourceTagContext', 'buildSrn']);

/** Properties a check's `action` may sit under: `check: { action }`. */
const CHECK_CARRIERS = new Set(['check', 'checks']);

export const ROUTE_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** A tag route set mounts these methods on its `path`. */
const TAG_ROUTE_METHODS = ['get', 'put', 'patch'];

/** A check naming no action of its own: the caller's. */
export const INHERIT = 'inherit';

const calleeName = (call) => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
};

/** The `action` a call's arguments name, at their top or under a carrier. */
const actionExpression = (call) => {
  let expression;
  const visit = (node) => {
    if (expression) return;
    const name = propName(node);
    if (name === 'action') {
      expression = ts.isPropertyAssignment(node) ? node.initializer : node.name;
      return;
    }
    if (name !== undefined && !CHECK_CARRIERS.has(name)) return;
    if (ts.isCallExpression(node) && NOT_CHECKS.has(calleeName(node))) return;
    ts.forEachChild(node, visit);
  };
  for (const arg of call.arguments) visit(arg);
  return expression;
};

const isCheck = (call) => {
  return (
    /^compile/.test(calleeName(call) ?? '') ||
    actionExpression(call) !== undefined
  );
};

/**
 * Whether a bare `action` passes the caller's through: a callback's parameter
 * (`ACTIONS.map((action) => …)`) names another action.
 */
const passesCallerAction = (identifier) => {
  for (let node = identifier.parent; node; node = node.parent) {
    if (!ts.isFunctionLike(node)) continue;
    const declares = node.parameters.some((parameter) => {
      return (
        ts.isIdentifier(parameter.name) &&
        parameter.name.text === identifier.text
      );
    });
    if (declares) return !ts.isCallExpression(node.parent);
  }
  return true;
};

/**
 * The actions a check call may name: the literals it can take, or `INHERIT`
 * when it names none or passes the caller's through (`action`, `args.action`).
 */
const actionsOf = (file, call) => {
  const expression = actionExpression(call);
  if (!expression) return [INHERIT];
  const literals = (node) => {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isConditionalExpression(node)) {
      return [...literals(node.whenTrue), ...literals(node.whenFalse)];
    }
    if (ts.isParenthesizedExpression(node)) return literals(node.expression);
    if (ts.isIdentifier(node)) {
      const found = lookup(file, node.text, 'consts');
      if (found) return [found.value];
      return node.text === 'action' && passesCallerAction(node)
        ? [INHERIT]
        : [];
    }
    return /\.action$/.test(node.getText()) ? [INHERIT] : [];
  };
  return literals(expression);
};

/** The literal actions the checks written in `fn` itself name. */
const ownActions = (file, fn) => {
  const actions = new Set();
  const visit = (node) => {
    if (ts.isCallExpression(node) && isCheck(node)) {
      for (const action of actionsOf(file, node)) {
        if (action !== INHERIT) actions.add(action);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return [...actions];
};

const resourceTypeLiteral = (node) => {
  return propName(node) === 'resourceType' &&
    ts.isPropertyAssignment(node) &&
    ts.isStringLiteralLike(node.initializer)
    ? node.initializer.text
    : undefined;
};

/** The identifier a property's value names: `{ resource }`, `{ resource: x }`. */
const referenceOf = (node) => {
  if (ts.isShorthandPropertyAssignment(node)) return node.name;
  return ts.isPropertyAssignment(node) && ts.isIdentifier(node.initializer)
    ? node.initializer
    : undefined;
};

/**
 * Literal SRN types in `node`, following identifiers to the local values they
 * name; an array of them (`resources: [...]`) is one group, any of which passes.
 */
const typeGroupsIn = (node, locals) => {
  const groups = [];
  const flat = (inner) => {
    const found = [];
    const visit = (child) => {
      const type = resourceTypeLiteral(child);
      if (type) found.push(type);
      ts.forEachChild(child, visit);
    };
    visit(inner);
    return found;
  };
  const visit = (child) => {
    if (
      ts.isCallExpression(child) &&
      calleeName(child) === 'buildResourceTagContext'
    ) {
      return;
    }
    if (ts.isArrayLiteralExpression(child)) {
      const group = flat(child);
      if (group.length > 0) groups.push(group);
      return;
    }
    const reference = referenceOf(child);
    if (reference && locals.has(reference.text)) {
      visit(locals.get(reference.text));
      return;
    }
    const type = resourceTypeLiteral(child);
    if (type) {
      groups.push([type]);
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return groups;
};

/** `collectionAccess.authorizeRead(…)`: a check on its factory's type. */
const typedCheck = (file, call) => {
  const callee = call.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression)
  ) {
    return undefined;
  }
  const typed = lookup(file, callee.expression.text, 'typed');
  return typed && (isCheck(call) || /^authorize/.test(callee.name.text))
    ? { actions: actionsOf(file, call), types: [typed.value] }
    : undefined;
};

/** A check call's actions; `compileFor({ resourceType })` takes its body's. */
const checkActions = (file, call, target) => {
  const named = actionsOf(file, call);
  const own = target ? ownActions(target.file, target.value) : [];
  return named.length === 1 && named[0] === INHERIT && own.length > 0
    ? own
    : named;
};

/**
 * Every check `node` reaches, following the functions it calls or hands over
 * by name, across files: `{ actions, types }`, where several `types` are one
 * check passing on any of them.
 */
const checksIn = (args) => {
  const { file, node, seen } = args;
  const checks = [];
  const locals = new Map();

  const follow = (target, name, callerActions) => {
    const key = `${target.file}#${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    for (const check of checksIn({
      file: target.file,
      node: target.value,
      seen,
    })) {
      checks.push({
        ...check,
        actions: check.actions.flatMap((action) => {
          return action === INHERIT ? callerActions : [action];
        }),
      });
    }
  };

  const resolveFunction = (name) => {
    const local = locals.get(name);
    return isFunction(local)
      ? { file, value: local }
      : lookup(file, name, 'functions');
  };

  const visitCall = (call) => {
    const typed = typedCheck(file, call);
    if (typed) checks.push(typed);
    const callee = call.expression;
    const target = ts.isIdentifier(callee)
      ? resolveFunction(callee.text)
      : undefined;
    if (isCheck(call) && !NOT_CHECKS.has(calleeName(call))) {
      const actions = checkActions(file, call, target);
      for (const arg of call.arguments) {
        for (const types of typeGroupsIn(arg, locals)) {
          checks.push({ actions, types });
        }
      }
    }
    if (target) follow(target, callee.text, actionsOf(file, call));
  };

  const visit = (child) => {
    if (
      ts.isVariableDeclaration(child) &&
      ts.isIdentifier(child.name) &&
      child.initializer
    ) {
      locals.set(child.name.text, child.initializer);
    }
    if (
      ts.isIdentifier(child) &&
      ts.isPropertyAssignment(child.parent) &&
      child.parent.initializer === child
    ) {
      // `resolve: resolveItemForTags`
      const target = resolveFunction(child.text);
      if (target) follow(target, child.text, [INHERIT]);
    }
    if (ts.isCallExpression(child)) {
      if (ALTERNATIVE_PATHS.has(calleeName(child))) return;
      visitCall(child);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return checks;
};

const specPath = (route) => {
  return `/api/v1${route.replace(/:(\w+)/g, '{$1}')}`;
};

/**
 * Each route a router file mounts: its `method /api/v1/...` key, the file and
 * the handler nodes. Read by `routeHeaderDeclaration.test.mjs` too.
 */
export const mountedRoutes = () => {
  const routes = [];
  for (const name of fs.readdirSync(routesDir).sort()) {
    if (!name.endsWith('.ts')) continue;
    const file = path.join(routesDir, name);
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const [first, ...rest] = node.arguments;
        const method = calleeName(node);
        if (
          ROUTE_METHODS.includes(method) &&
          ts.isPropertyAccessExpression(node.expression) &&
          /Router$/.test(node.expression.expression.getText()) &&
          first &&
          ts.isStringLiteralLike(first)
        ) {
          routes.push({
            key: `${method} ${specPath(first.text)}`,
            file,
            nodes: rest,
          });
          return;
        }
        const tagPath = literalProp(first, 'path');
        if (method === 'registerTagRoutes' && tagPath) {
          for (const verb of TAG_ROUTE_METHODS) {
            routes.push({
              key: `${verb} ${specPath(tagPath)}`,
              file,
              nodes: [first],
            });
          }
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file));
  }
  return routes;
};

/** Each route a router file mounts, with the checks its handlers reach. */
export const routeChecks = () => {
  const routes = new Map();
  for (const { key, file, nodes } of mountedRoutes()) {
    const seen = new Set();
    routes.set(
      key,
      nodes.flatMap((node) => {
        return checksIn({ file, node, seen });
      })
    );
  }
  return routes;
};

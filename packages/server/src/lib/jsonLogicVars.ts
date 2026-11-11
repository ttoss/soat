import { isPlainObject } from './plainObject';

// The arguments json-logic-engine evaluates against each element (`reduce`:
// `{ current, accumulator }`) rather than the data the operator itself sees.
const ITERATOR_SCOPED_ARGUMENT: Record<string, number> = {
  all: 1,
  every: 1,
  filter: 1,
  map: 1,
  none: 1,
  reduce: 1,
  some: 1,
};

// Each iterator level pushes two entries onto json-logic-engine's `above`
// chain (iteration metadata, then the enclosing data), so a var climbs one
// level per two `../`.
const PARENT_PREFIX = '../';
const PREFIXES_PER_LEVEL = 2;

/**
 * The path a JSON Logic `var` argument selects: a bare string, or the first
 * element of a `[path, default]` array. A non-string argument selects nothing
 * resolvable.
 */
const varArgPath = (arg: unknown): string | undefined => {
  if (typeof arg === 'string') return arg;
  if (Array.isArray(arg) && typeof arg[0] === 'string') return arg[0];
  return undefined;
};

export type LogicOperatorNode = {
  operator: string;
  argument: unknown;
  depth: number;
};

/**
 * Visits every operator node of a JSON Logic expression with its iterator
 * depth: 0 at the expression's own data, plus one inside each iterator body.
 */
export const walkLogicOperators = (args: {
  node: unknown;
  depth: number;
  visit: (node: LogicOperatorNode) => void;
}): void => {
  const { node, depth, visit } = args;
  if (Array.isArray(node)) {
    for (const item of node) {
      walkLogicOperators({ node: item, depth, visit });
    }
    return;
  }
  if (!isPlainObject(node)) return;
  const keys = Object.keys(node);
  if (keys.length === 1) {
    const [operator] = keys;
    const argument = node[operator];
    visit({ operator, argument, depth });
    const scoped = ITERATOR_SCOPED_ARGUMENT[operator];
    if (scoped !== undefined && Array.isArray(argument)) {
      for (const [index, item] of argument.entries()) {
        walkLogicOperators({
          node: item,
          depth: index === scoped ? depth + 1 : depth,
          visit,
        });
      }
      return;
    }
  }
  for (const value of Object.values(node)) {
    walkLogicOperators({ node: value, depth, visit });
  }
};

/**
 * The root-data path a `var` at `depth` reads, or `undefined` when it reads an
 * iterator's own scope (an element, `current`, `accumulator`, `../index`).
 */
const rootVarPath = (args: {
  path: string;
  depth: number;
}): string | undefined => {
  if (args.depth === 0) return args.path;
  let parents = 0;
  while (args.path.startsWith(PARENT_PREFIX.repeat(parents + 1))) {
    parents += 1;
  }
  const rootParents = args.depth * PREFIXES_PER_LEVEL;
  if (parents < rootParents) return undefined;
  return args.path.slice(rootParents * PARENT_PREFIX.length);
};

/**
 * The root path an operand reads when it is a `var` node at `depth`;
 * `undefined` for any other operand or an iterator-scoped var.
 */
export const operandRootVarPath = (args: {
  operand: unknown;
  depth: number;
}): string | undefined => {
  if (!isPlainObject(args.operand)) return undefined;
  const keys = Object.keys(args.operand);
  if (keys.length !== 1 || keys[0] !== 'var') return undefined;
  const path = varArgPath(args.operand.var);
  if (path === undefined) return undefined;
  return rootVarPath({ path, depth: args.depth });
};

/**
 * The root path of every `var` in an expression, in first-seen order with
 * repeats. Iterator-scoped vars are left out; a var reached through `../` is
 * reported by the root path it resolves to.
 */
export const rootVarPaths = (expression: unknown): string[] => {
  const paths: string[] = [];
  walkLogicOperators({
    node: expression,
    depth: 0,
    visit: ({ operator, argument, depth }) => {
      if (operator !== 'var') return;
      const path = operandRootVarPath({ operand: { var: argument }, depth });
      if (path !== undefined) paths.push(path);
    },
  });
  return paths;
};

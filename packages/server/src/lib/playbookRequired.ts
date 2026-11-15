import { DomainError } from '../errors';
import { evaluateLogic, isLogic } from './jsonLogicMapping';
import { rootVarPaths } from './jsonLogicVars';
import { isPlainObject } from './plainObject';
import type {
  JsonValue,
  PlaybookInput,
  PlaybookNode,
  PlaybookRequired,
} from './playbookDefinition';
import { stableDigest } from './stableDigest';
import type { ValidationProblem } from './validationProblems';

/**
 * The one reader of an input's `required`: whether each input of `node` is
 * required in a case, given the values of its inputs that are set and satisfy
 * their schema. An expression that fails to evaluate reads as required.
 */
export const resolveRequired = (args: {
  node: PlaybookNode;
  values: Record<string, JsonValue>;
}): Record<string, boolean> => {
  const scope: Record<string, JsonValue> = {};
  for (const { name } of args.node.inputs) {
    scope[name] = args.values[name] ?? null;
  }

  return Object.fromEntries(
    args.node.inputs.map(({ name, required }) => {
      if (typeof required === 'boolean') return [name, required];
      try {
        return [name, evaluateLogic({ '!!': [required] }, scope) === true];
      } catch {
        return [name, true];
      }
    })
  );
};

/** Parses a request body's `required`: a boolean or a JSON Logic expression. */
export const readRequired = (args: {
  path: string;
  value: unknown;
}): PlaybookRequired => {
  const { value } = args;
  if (typeof value === 'boolean') return value;
  if (isPlainObject(value) && isLogic(value)) {
    // Read off a JSON body, so already a JSON value.
    return value as PlaybookRequired;
  }
  throw new DomainError(
    'VALIDATION_FAILED',
    `${args.path} must be a boolean or a JSON Logic expression.`
  );
};

export const sameRequired = (args: {
  left: PlaybookInput;
  right: PlaybookInput;
}): boolean => {
  return stableDigest(args.left.required) === stableDigest(args.right.required);
};

/** An expression reads only the other inputs of its node, by name. */
export const requiredProblems = (args: {
  node: PlaybookNode;
  path: string;
}): ValidationProblem[] => {
  const { node } = args;

  return node.inputs.flatMap(({ name, required }, index) => {
    if (typeof required === 'boolean') return [];
    const unknown = rootVarPaths(required)
      .map((path) => {
        return path.split('.')[0] ?? '';
      })
      .filter((root) => {
        return (
          root === name ||
          !node.inputs.some((input) => {
            return input.name === root;
          })
        );
      });

    return [...new Set(unknown)].map((root) => {
      return {
        code: 'UNKNOWN_FIELD',
        path: `${args.path}.inputs[${index}].required`,
        message: `Input '${name}' of node '${node.id}' is required on '${root}', which is not another input of the node.`,
      };
    });
  });
};

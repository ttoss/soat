import type { ErrorObject } from 'ajv';

import {
  getRequestBodyValidator,
  getSpecFragmentValidator,
} from './openapiJsonSchema';
import { isObjectRecord } from './openapiSchemaFields';

export type SchemaViolation = { field: string; message: string };

const UNION_KEYWORDS = new Set(['oneOf', 'anyOf']);
const TAG_KEYWORDS = new Set(['enum', 'const']);

/** The error's value path as segments, a missing property included. */
const pathOf = (error: ErrorObject): string[] => {
  const segments = error.instancePath.split('/').slice(1);
  const missing = error.params.missingProperty;
  return error.keyword === 'required' && typeof missing === 'string'
    ? [...segments, missing]
    : segments;
};

const isAtOrUnder = (path: string, base: string): boolean => {
  return path === base || path.startsWith(`${base}/`);
};

const messageOf = (args: { error: ErrorObject; field: string }): string => {
  const { error, field } = args;
  if (error.keyword === 'required') return `\`${field}\` is required`;
  const allowed = error.params.allowedValues;
  if (error.keyword === 'enum' && Array.isArray(allowed)) {
    return `\`${field}\` must be one of: ${allowed.join(', ')} (got ${JSON.stringify(error.data)})`;
  }
  return `\`${field}\` ${error.message ?? 'is invalid'}`;
};

/**
 * A union whose value matches no branch is reported once, as the union's own
 * error, instead of one error per branch it failed.
 */
const withoutBranchErrors = (errors: ErrorObject[]): ErrorObject[] => {
  const failedUnions = errors
    .filter((error) => {
      return UNION_KEYWORDS.has(error.keyword);
    })
    .map((error) => {
      return error.instancePath;
    });
  return errors.filter((error) => {
    const isUnion = UNION_KEYWORDS.has(error.keyword);
    return !failedUnions.some((base) => {
      return isUnion
        ? base !== error.instancePath && isAtOrUnder(error.instancePath, base)
        : isAtOrUnder(error.instancePath, base);
    });
  });
};

/** A refused value of a property of the branch's own value. */
const isTagError = (error: ErrorObject): boolean => {
  return (
    TAG_KEYWORDS.has(error.keyword) &&
    error.instancePath.split('/').length === 2
  );
};

/**
 * A branch the value is not of at all: of another type, or carrying a
 * property (`type`, `kind`) whose value names another branch.
 */
const rulesOut = (errors: ErrorObject[]): boolean => {
  return errors.some((error) => {
    return (
      (error.instancePath === '' && error.keyword === 'type') ||
      isTagError(error)
    );
  });
};

const allowedValuesOf = (error: ErrorObject): unknown[] => {
  const { allowedValues, allowedValue } = error.params;
  return Array.isArray(allowedValues) ? allowedValues : [allowedValue];
};

/**
 * Every branch refuses the same tag property: that property's refusal, naming
 * the values the branches allow; `null` when they do not agree on one.
 */
const tagRefusal = (branches: ErrorObject[][]): ErrorObject | null => {
  const tags = branches.map((errors) => {
    return errors.find(isTagError);
  });
  const [first] = tags;
  const agree = tags.every((tag) => {
    return tag !== undefined && tag.instancePath === first?.instancePath;
  });
  if (!first || !agree) return null;
  return {
    ...first,
    keyword: 'enum',
    params: {
      allowedValues: tags.flatMap((tag) => {
        return tag ? allowedValuesOf(tag) : [];
      }),
    },
  };
};

const withinUnion = (args: {
  union: ErrorObject;
  errors: ErrorObject[];
}): ErrorObject[] => {
  return args.errors.map((error) => {
    return {
      ...error,
      instancePath: `${args.union.instancePath}${error.instancePath}`,
    };
  });
};

/**
 * A failed union answers with the errors of the one branch its value is of,
 * or with the tag every branch refuses; otherwise with its own error.
 */
const explainUnion = (args: {
  union: ErrorObject;
  explain: (errors: ErrorObject[]) => ErrorObject[];
}): ErrorObject[] => {
  const { union } = args;
  const branchSchemas: unknown = union.schema;
  if (!Array.isArray(branchSchemas) || union.params.passingSchemas) {
    return [union];
  }
  const branches = branchSchemas.filter(isObjectRecord).map((branch) => {
    const validate = getSpecFragmentValidator(branch);
    validate(union.data);
    return [...(validate.errors ?? [])];
  });
  const candidates = branches.filter((errors) => {
    return !rulesOut(errors);
  });
  if (candidates.length === 1) {
    return withinUnion({ union, errors: args.explain(candidates[0]) });
  }
  const tag = candidates.length === 0 ? tagRefusal(branches) : null;
  return tag ? withinUnion({ union, errors: [tag] }) : [union];
};

const explained = (errors: ErrorObject[]): ErrorObject[] => {
  return withoutBranchErrors(errors).flatMap((error) => {
    return UNION_KEYWORDS.has(error.keyword)
      ? explainUnion({ union: error, explain: explained })
      : [error];
  });
};

/**
 * Where a request body breaks its operation's full request schema, at any
 * depth. `template` is the OpenAPI path key.
 */
export const collectSchemaViolations = (args: {
  method: string;
  template: string;
  body: Record<string, unknown>;
}): SchemaViolation[] => {
  const validate = getRequestBodyValidator({
    template: args.template,
    method: args.method,
  });
  if (!validate || validate(args.body)) return [];

  const seen = new Set<string>();
  return explained([...(validate.errors ?? [])])
    .map((error) => {
      const field = pathOf(error).join('.') || '(body)';
      return { field, message: messageOf({ error, field }) };
    })
    .filter((violation) => {
      if (seen.has(violation.message)) return false;
      seen.add(violation.message);
      return true;
    });
};

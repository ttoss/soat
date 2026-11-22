import type { ErrorObject } from 'ajv';

import { getRequestBodyValidator } from './openapiJsonSchema';
import { isRouteOwnedField } from './routeOwnedBodyFields';

export type SchemaViolation = { field: string; message: string };

const UNION_KEYWORDS = new Set(['oneOf', 'anyOf']);

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

/**
 * Where a request body breaks its operation's full request schema, at any
 * depth, leaving out the fields the route answers itself
 * (`ROUTE_OWNED_BODY_FIELDS`). `template` is the OpenAPI path key.
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

  const operation = `${args.method.toUpperCase()} ${args.template}`;
  const errors = (validate.errors ?? []).filter((error) => {
    return !isRouteOwnedField({ operation, path: pathOf(error) });
  });

  const seen = new Set<string>();
  return withoutBranchErrors(errors)
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

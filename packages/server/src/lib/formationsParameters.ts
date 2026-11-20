import createDebug from 'debug';
import { DomainError } from 'src/errors';

import type {
  FormationTemplate,
  ParameterDeclaration,
  ValidationError,
} from './formationsTypes';

const log = createDebug('soat:formationsParameters');

/**
 * How a parameter value reads, by its declared `type`. A deploy-time value is
 * always a string; a `default` may already be the typed value. Every path that
 * resolves a parameter goes through `resolveParameterValues`, so an untyped
 * value never reaches a resource.
 */
const PARAMETER_TYPES = {
  string: {
    expects: 'a string',
    coerce: (value: unknown): { value: unknown } | null => {
      return typeof value === 'string' ? { value } : null;
    },
  },
  number: {
    expects: 'a number',
    coerce: (value: unknown): { value: unknown } | null => {
      if (typeof value === 'number') {
        return Number.isFinite(value) ? { value } : null;
      }
      if (typeof value !== 'string' || value.trim() === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? { value: parsed } : null;
    },
  },
  list: {
    expects: 'a JSON array',
    coerce: (value: unknown): { value: unknown } | null => {
      if (Array.isArray(value)) return { value };
      if (typeof value !== 'string') return null;
      try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? { value: parsed } : null;
      } catch {
        return null;
      }
    },
  },
} as const;

type ParameterType = keyof typeof PARAMETER_TYPES;

const isParameterType = (type: string): type is ParameterType => {
  return Object.hasOwn(PARAMETER_TYPES, type);
};

const typeOf = (decl: ParameterDeclaration): ParameterType => {
  return decl.type !== undefined && isParameterType(decl.type)
    ? decl.type
    : 'string';
};

/** Errors in one declaration: an unknown `type`, or a default of the wrong type. */
export const parameterDeclarationErrors = (args: {
  name: string;
  decl: Record<string, unknown>;
}): ValidationError[] => {
  const { name, decl } = args;
  const path = `parameters.${name}`;
  if (decl.type === undefined) return [];
  if (typeof decl.type !== 'string') {
    return [{ path: `${path}.type`, message: '`type` must be a string' }];
  }
  if (!isParameterType(decl.type)) {
    return [
      {
        path: `${path}.type`,
        message: `\`type\` must be one of: ${Object.keys(PARAMETER_TYPES).join(', ')}`,
      },
    ];
  }
  const { coerce, expects } = PARAMETER_TYPES[decl.type];
  if (decl.default === undefined) return [];
  if (coerce(decl.default) !== null) return [];
  return [
    {
      path: `${path}.default`,
      message: `Default of ${decl.type} parameter '${name}' must be ${expects}`,
    },
  ];
};

const resolveEach = (
  template: FormationTemplate,
  provided: Record<string, string> | undefined
): { resolved: Map<string, unknown>; errors: ValidationError[] } => {
  const resolved = new Map<string, unknown>();
  const errors: ValidationError[] = [];
  for (const [name, decl] of Object.entries(template.parameters ?? {})) {
    const providedValue = provided?.[name];
    // A parameter declared `use_previous_value` and not supplied is left
    // unresolved on purpose: its `{ param: ... }` expression resolves to
    // `undefined`, the field is dropped, and the existing value is preserved.
    const raw = providedValue !== undefined ? providedValue : decl.default;
    if (raw === undefined) continue;
    const type = typeOf(decl);
    // An untyped default keeps the value the template wrote.
    if (providedValue === undefined && decl.type === undefined) {
      resolved.set(name, raw);
      continue;
    }
    const coerced = PARAMETER_TYPES[type].coerce(raw);
    if (coerced === null) {
      errors.push({
        path: `parameters.${name}`,
        message: `Parameter '${name}' is declared ${type} and must be ${PARAMETER_TYPES[type].expects}`,
      });
      continue;
    }
    resolved.set(name, coerced.value);
  }
  return { resolved, errors };
};

/** The errors `resolveParameterValues` would refuse with, for `validate`. */
export const parameterValueErrors = (
  template: FormationTemplate,
  provided?: Record<string, string>
): ValidationError[] => {
  return resolveEach(template, provided).errors;
};

/**
 * Each declared parameter's provided-or-default value, typed by its declared
 * `type`. A value that does not parse as its type is refused.
 */
export const resolveParameterValues = (
  template: FormationTemplate,
  provided?: Record<string, string>
): Map<string, unknown> => {
  const { resolved, errors } = resolveEach(template, provided);
  log(
    'resolveParameterValues: resolved=%d errors=%d',
    resolved.size,
    errors.length
  );
  if (errors.length === 0) return resolved;
  throw new DomainError(
    'FORMATION_INVALID_PARAMETERS',
    `Invalid parameter values: ${errors
      .map((error) => {
        return error.message;
      })
      .join('; ')}`,
    { details: errors }
  );
};

/** A resolved value as text: what a `sub` embeds and `resolved_parameters` records. */
export const parameterText = (value: unknown): string => {
  return typeof value === 'string' ? value : JSON.stringify(value);
};

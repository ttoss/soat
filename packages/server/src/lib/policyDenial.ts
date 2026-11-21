import { DomainError, isDeclaredDenialCode } from '../errors';
import { isPlainObject } from './plainObject';

const DENIAL_KEYS = new Set(['code', 'message', 'meta']);
const META_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
/** What every denial's `meta` carries; a statement never sets them. */
const SERVER_META_KEYS = new Set(['action', 'resource', 'denied_by']);

const validateDenialMeta = (args: {
  meta: unknown;
  prefix: string;
  errors: string[];
}): void => {
  if (args.meta === undefined) return;
  if (!isPlainObject(args.meta)) {
    args.errors.push(`${args.prefix}.meta: must be an object`);
    return;
  }
  for (const key of Object.keys(args.meta)) {
    if (!META_KEY_PATTERN.test(key) || SERVER_META_KEYS.has(key)) {
      args.errors.push(
        `${args.prefix}.meta: key "${key}" must be snake_case and none of ${[...SERVER_META_KEYS].join(', ')}`
      );
    }
  }
};

/** Structural: a `denial` is `{ code, message, meta? }` on a `Deny`. */
export const validateDenialField = (args: {
  denial: unknown;
  effect: unknown;
  prefix: string;
  errors: string[];
}): void => {
  const { denial, errors } = args;
  if (denial === undefined) return;
  const prefix = `${args.prefix}.denial`;
  if (args.effect !== 'Deny') {
    errors.push(`${prefix}: only a Deny statement carries a denial`);
  }
  if (!isPlainObject(denial)) {
    errors.push(`${prefix}: must be an object`);
    return;
  }
  for (const key of Object.keys(denial)) {
    if (!DENIAL_KEYS.has(key)) {
      errors.push(`${prefix}: unknown key "${key}"`);
    }
  }
  if (typeof denial.code !== 'string' || denial.code === '') {
    errors.push(`${prefix}.code: must be a non-empty string`);
  }
  if (typeof denial.message !== 'string' || denial.message.trim() === '') {
    errors.push(`${prefix}.message: must be a non-empty string`);
  }
  validateDenialMeta({ meta: denial.meta, prefix, errors });
};

const statementDenials = (doc: unknown): Array<[number, unknown]> => {
  if (!isPlainObject(doc) || !Array.isArray(doc.statement)) return [];
  return doc.statement.flatMap((stmt: unknown, index: number) => {
    return isPlainObject(stmt) && stmt.denial !== undefined
      ? [[index, stmt.denial] as [number, unknown]]
      : [];
  });
};

/**
 * Authoring check: each `denial.code` is one the deployment declares
 * (`denial_codes`), so a policy answers no code a deployment has no hint for.
 */
export const collectUndeclaredDenialCodeErrors = (args: {
  doc: unknown;
  errors: string[];
}): void => {
  for (const [index, denial] of statementDenials(args.doc)) {
    const code = isPlainObject(denial) ? denial.code : undefined;
    if (typeof code === 'string' && !isDeclaredDenialCode(code)) {
      args.errors.push(
        `statement[${index}].denial.code: "${code}" is not a denial code this deployment declares`
      );
    }
  }
};

export const carriesDenial = (doc: unknown): boolean => {
  return statementDenials(doc).length > 0;
};

/**
 * A denial decides what every caller under the policy reads, so only an
 * unrestricted admin writes a policy carrying one.
 */
export const assertMayWriteDenial = (args: {
  document: unknown;
  writerUnrestricted: boolean;
}): void => {
  if (args.writerUnrestricted || !carriesDenial(args.document)) return;
  throw new DomainError(
    'POLICY_DENIAL_RESERVED',
    'Only an unrestricted admin may write a policy statement carrying a denial.'
  );
};

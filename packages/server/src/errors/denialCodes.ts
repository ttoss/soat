/**
 * The codes a deployment's policies may answer a denial with, each with its
 * hint: `denial_codes` in the IAM registrations file, `[{ code, hint }]`. A
 * statement's `denial.code` must be one of them (`lib/policyDenial.ts`).
 */
import { ERROR_CODES } from './codes';

const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

let declared: ReadonlyMap<string, string> = new Map();

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const entryProblem = (args: {
  entry: unknown;
  parsed: ReadonlyMap<string, string>;
}): string | null => {
  const code = isRecord(args.entry) ? args.entry.code : undefined;
  const hint = isRecord(args.entry) ? args.entry.hint : undefined;
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
    return `.code must match ${CODE_PATTERN.source}`;
  }
  if (Object.hasOwn(ERROR_CODES, code) || args.parsed.has(code)) {
    return `.code '${code}' is already defined`;
  }
  if (typeof hint !== 'string' || hint.trim() === '') {
    return '.hint must be a non-empty string';
  }
  return null;
};

/** Throws on anything but an absent key or `[{ code, hint }]` of new codes. */
export const parseDenialCodes = (args: {
  config: unknown;
  source: string;
}): Map<string, string> => {
  const fail = (detail: string): never => {
    throw new Error(`Invalid denial codes (${args.source}): ${detail}`);
  };
  const entries = isRecord(args.config) ? args.config.denial_codes : undefined;
  if (entries === undefined) return new Map();
  if (!Array.isArray(entries)) return fail('`denial_codes` must be an array');
  const parsed = new Map<string, string>();
  for (const [index, entry] of entries.entries()) {
    const problem = entryProblem({ entry, parsed });
    if (problem) return fail(`denial_codes[${index}]${problem}`);
    if (isRecord(entry)) parsed.set(String(entry.code), String(entry.hint));
  }
  return parsed;
};

/** Called once at boot, and by tests; replaces what was declared. */
export const declareDenialCodes = (args: {
  codes: ReadonlyMap<string, string>;
}): void => {
  declared = args.codes;
};

export const isDeclaredDenialCode = (code: string): boolean => {
  return declared.has(code);
};

export const denialCodeHint = (code: string): string | undefined => {
  return declared.get(code);
};

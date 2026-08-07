import type { ParsedFlags } from './types.js';

export const parseUnknownWithRepeats = (args: {
  cliArgs: string[];
}): ParsedFlags => {
  const { cliArgs } = args;
  const single: Record<string, string> = {};
  const repeated: Record<string, string[]> = {};

  for (let i = 0; i < cliArgs.length; i++) {
    const arg = cliArgs[i];
    if (!arg?.startsWith('--')) continue;

    const inlineSplitIdx = arg.indexOf('=');
    const hasInlineValue = inlineSplitIdx > 2;
    const key = hasInlineValue ? arg.slice(2, inlineSplitIdx) : arg.slice(2);

    let value: string;
    if (hasInlineValue) {
      value = arg.slice(inlineSplitIdx + 1);
    } else {
      const next = cliArgs[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      } else {
        value = 'true';
      }
    }

    single[key] = value;
    if (!repeated[key]) {
      repeated[key] = [];
    }
    repeated[key].push(value);
  }

  return { single, repeated };
};

/**
 * Extracts bare (non-`--flag`) tokens from raw CLI args, e.g. the `frm_123` in
 * `soat get-formation frm_123`. Walks the same flag/value pairing as
 * `parseUnknownWithRepeats` so a flag's value (`--name frm_123`) is never
 * mistaken for a standalone positional argument.
 */
export const extractPositionalArgs = (args: {
  cliArgs: string[];
}): string[] => {
  const { cliArgs } = args;
  const positional: string[] = [];

  for (let i = 0; i < cliArgs.length; i++) {
    const arg = cliArgs[i];
    if (arg === undefined) continue;

    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const inlineSplitIdx = arg.indexOf('=');
    const hasInlineValue = inlineSplitIdx > 2;
    if (hasInlineValue) continue;

    const next = cliArgs[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      i++;
    }
  }

  return positional;
};

/**
 * Coerce a raw flag value to the JSON type the spec declares for it.
 *
 * `declaredType` comes from the generated route manifest. A flag the spec
 * declares as `string` is passed through untouched — its content is data, not
 * syntax, so a value that merely *looks* like JSON (a GCP service account key
 * file in `create-secret --value`) or like a number (an account number) must
 * still arrive as a string. Coercing it produced a body the server rejects,
 * with no way to escape it from the shell.
 *
 * The one value a string flag still coerces is the literal `null`: "set it to
 * null to clear" is the documented way to detach a nullable reference
 * (`--default_model_route_id null`, `--ai_provider_id null`), and the shell has
 * no other way to spell JSON null. The cost is that a string whose entire value
 * is `null` cannot be sent — a far rarer need than clearing a field.
 *
 * Every other flag keeps the permissive behavior: an undeclared type (a flag
 * the manifest has no entry for) is still sniffed, since that is the only
 * signal available.
 */
export const parseFlagValue = (
  value: string,
  declaredType?: string
): unknown => {
  if (declaredType === 'string') return value.trim() === 'null' ? null : value;

  const trimmed = value.trim();

  if (
    trimmed.startsWith('{') ||
    trimmed.startsWith('[') ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    /^-?\d+(\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
};

/**
 * Build the value for an array-typed flag. Collects repeated occurrences
 * (`--document_paths /a/ --document_paths /b/`) into a list, coercing each
 * element with `parseFlagValue`. A single JSON-array literal
 * (`--document_ids '["doc_1","doc_2"]'`) is passed through as-is rather than
 * being wrapped again, and a single scalar (`--document_paths /playbooks/`)
 * becomes a one-element array.
 */
export const buildArrayFlagValue = (rawValues: string[]): unknown => {
  const parsed = rawValues.map((v) => {
    return parseFlagValue(v);
  });
  if (parsed.length === 1 && Array.isArray(parsed[0])) {
    return parsed[0];
  }
  return parsed;
};

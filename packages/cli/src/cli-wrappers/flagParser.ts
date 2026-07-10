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

/**
 * A deployment's own hints, replacing the runtime's per code: advice that names
 * a route the deployment does not serve or a flow it runs differently. Loaded
 * from the JSON file `SOAT_ERROR_HINTS_CONFIG` names, `{ "hints": { CODE:
 * text } }`; text may carry route tokens (`hintRoutes.ts`).
 */

import * as fs from 'node:fs';

import createDebug from 'debug';

import { ERROR_CODES } from './codes';

const log = createDebug('soat:errors');

export const ERROR_HINTS_CONFIG_ENV = 'SOAT_ERROR_HINTS_CONFIG';

let overrides: ReadonlyMap<string, string> = new Map();

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/** Throws on anything but `{ hints: { <runtime code>: <non-empty text> } }`. */
export const parseErrorHintOverrides = (args: {
  config: unknown;
  source: string;
}): Map<string, string> => {
  const fail = (detail: string): never => {
    throw new Error(`Error hints config (${args.source}): ${detail}`);
  };
  if (!isRecord(args.config)) return fail('must be a JSON object');
  const extra = Object.keys(args.config).filter((key) => {
    return key !== 'hints';
  });
  if (extra.length > 0) fail(`unknown key(s): ${extra.join(', ')}`);
  const { hints } = args.config;
  if (!isRecord(hints)) return fail('`hints` must be an object');

  const parsed = new Map<string, string>();
  for (const [code, text] of Object.entries(hints)) {
    if (!Object.hasOwn(ERROR_CODES, code)) {
      fail(`\`hints.${code}\` names a code the runtime does not define`);
    }
    if (typeof text !== 'string' || text.trim() === '') {
      fail(`\`hints.${code}\` must be a non-empty string`);
    }
    parsed.set(code, String(text));
  }
  return parsed;
};

/** Called once at boot; any problem fails the boot. Replaces what was loaded. */
export const initErrorHintOverrides = (args: {
  env: Record<string, string | undefined>;
}): void => {
  const source = args.env[ERROR_HINTS_CONFIG_ENV];
  if (!source) {
    overrides = new Map();
    return;
  }
  log('initErrorHintOverrides: source=%s', source);
  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(source, 'utf-8'));
  } catch (error) {
    throw new Error(
      `Could not load error hints config (${source}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
  overrides = parseErrorHintOverrides({ config, source });
};

export const errorHintOverride = (args: {
  code: string;
}): string | undefined => {
  return overrides.get(args.code);
};

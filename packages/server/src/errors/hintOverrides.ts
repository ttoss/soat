/**
 * A deployment's own hints, replacing the runtime's per code: advice that names
 * a route the deployment does not serve or a flow it runs differently; and the
 * `meta` keys it omits per code, those counting what it does not serve. Loaded
 * from the JSON file `SOAT_ERROR_HINTS_CONFIG` names, `{ "hints": { CODE:
 * text }, "omit_meta": { CODE: [key] } }`; text may carry route tokens
 * (`hintRoutes.ts`).
 */

import * as fs from 'node:fs';

import createDebug from 'debug';

import { ERROR_CODES } from './codes';

const log = createDebug('soat:errors');

export const ERROR_HINTS_CONFIG_ENV = 'SOAT_ERROR_HINTS_CONFIG';

type ErrorOverrides = {
  hints: ReadonlyMap<string, string>;
  omitMeta: ReadonlyMap<string, readonly string[]>;
};

const NONE: ErrorOverrides = { hints: new Map(), omitMeta: new Map() };

let overrides: ErrorOverrides = NONE;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const TOP_LEVEL_KEYS = new Set(['hints', 'omit_meta']);

const isKeyList = (value: unknown): value is string[] => {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((key) => {
      return typeof key === 'string' && key.trim() !== '';
    })
  );
};

/**
 * Throws on anything but `{ hints?: { <runtime code>: <non-empty text> },
 * omit_meta?: { <runtime code>: [<non-empty key>, …] } }`.
 */
export const parseErrorHintOverrides = (args: {
  config: unknown;
  source: string;
}): ErrorOverrides => {
  const fail = (detail: string): never => {
    throw new Error(`Error hints config (${args.source}): ${detail}`);
  };
  const { config } = args;
  if (!isRecord(config)) return fail('must be a JSON object');
  const extra = Object.keys(config).filter((key) => {
    return !TOP_LEVEL_KEYS.has(key);
  });
  if (extra.length > 0) fail(`unknown key(s): ${extra.join(', ')}`);

  const entries = (field: string): [string, unknown][] => {
    const value = config[field] ?? {};
    if (!isRecord(value)) return fail(`\`${field}\` must be an object`);
    return Object.entries(value).map(([code, entry]) => {
      if (!Object.hasOwn(ERROR_CODES, code)) {
        fail(`\`${field}.${code}\` names a code the runtime does not define`);
      }
      return [code, entry];
    });
  };

  const hints = new Map<string, string>();
  for (const [code, text] of entries('hints')) {
    if (typeof text !== 'string' || text.trim() === '') {
      return fail(`\`hints.${code}\` must be a non-empty string`);
    }
    hints.set(code, text);
  }
  const omitMeta = new Map<string, readonly string[]>();
  for (const [code, keys] of entries('omit_meta')) {
    if (!isKeyList(keys)) {
      return fail(`\`omit_meta.${code}\` must be a non-empty list of keys`);
    }
    omitMeta.set(code, keys);
  }
  return { hints, omitMeta };
};

/** Called once at boot; any problem fails the boot. Replaces what was loaded. */
export const initErrorHintOverrides = (args: {
  env: Record<string, string | undefined>;
}): void => {
  const source = args.env[ERROR_HINTS_CONFIG_ENV];
  if (!source) {
    overrides = NONE;
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
  return overrides.hints.get(args.code);
};

/** The `meta` keys the deployment omits from `code`'s errors. */
export const omittedErrorMeta = (args: { code: string }): readonly string[] => {
  return overrides.omitMeta.get(args.code) ?? [];
};

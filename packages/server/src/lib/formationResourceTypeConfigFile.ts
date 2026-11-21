/**
 * The file `FORMATION_RESOURCE_TYPES_CONFIG` names: the types it registers
 * (`formationResourceTypeConfig.ts`) and the built-ins it disables.
 */

import * as fs from 'node:fs';

import createDebug from 'debug';

import {
  failFormationConfig as fail,
  FORMATION_RESOURCE_TYPES_CONFIG_ENV,
  type FormationResourceTypeRegistration,
  parseFormationResourceTypeConfig,
} from './formationResourceTypeConfig';
import { isObjectRecord } from './openapiSchemaFields';

const log = createDebug('soat:formations:resourceTypes');

/**
 * `disabled_resource_types`: built-ins a template on this deployment may not
 * declare. Optional; each must be a built-in the file does not also register,
 * since disabling a type and serving it are contradictory.
 */
export const parseDisabledResourceTypes = (args: {
  config: unknown;
  builtInTypes: ReadonlySet<string>;
  registrations: FormationResourceTypeRegistration[];
  source: string;
}): ReadonlySet<string> => {
  const { config, builtInTypes, registrations, source } = args;
  if (!isObjectRecord(config) || config.disabled_resource_types === undefined) {
    return new Set();
  }
  const names = config.disabled_resource_types;
  if (
    !Array.isArray(names) ||
    !names.every((name) => {
      return typeof name === 'string';
    })
  ) {
    return fail({
      source,
      message: '`disabled_resource_types` must be an array of strings',
    });
  }
  const registered = new Set(
    registrations.map((registration) => {
      return registration.name;
    })
  );
  const disabled = new Set<string>();
  for (const name of names) {
    if (!builtInTypes.has(name)) {
      return fail({
        source,
        message: `\`disabled_resource_types\`: '${name}' is not a built-in type`,
      });
    }
    if (registered.has(name)) {
      return fail({
        source,
        message: `\`disabled_resource_types\`: '${name}' is also registered in \`resource_types\``,
      });
    }
    if (disabled.has(name)) {
      return fail({
        source,
        message: `\`disabled_resource_types\`: '${name}' is listed twice`,
      });
    }
    disabled.add(name);
  }
  return disabled;
};

// ── Loading ───────────────────────────────────────────────────────────────

export type FormationResourceTypeConfig = {
  registrations: FormationResourceTypeRegistration[];
  disabledTypes: ReadonlySet<string>;
};

/**
 * Reads the registration file named by `FORMATION_RESOURCE_TYPES_CONFIG`, or
 * returns nothing when the variable is unset — the overwhelmingly common case,
 * and the one where a deployment runs on every built-in resource type alone.
 */
export const loadFormationResourceTypeConfig = (args: {
  builtInTypes: ReadonlySet<string>;
  env: Record<string, string | undefined>;
}): FormationResourceTypeConfig => {
  const source = args.env[FORMATION_RESOURCE_TYPES_CONFIG_ENV];
  if (!source) return { registrations: [], disabledTypes: new Set() };

  log('loading formation resource type registrations from %s', source);

  let raw: string;
  try {
    raw = fs.readFileSync(source, 'utf-8');
  } catch (error) {
    throw new Error(
      `Could not read formation resource type config (${source}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }

  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Could not parse formation resource type config (${source}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }

  const registrations = parseFormationResourceTypeConfig({
    config,
    builtInTypes: args.builtInTypes,
    env: args.env,
    source,
  });

  const overrides = registrations.filter((registration) => {
    return registration.overridesBuiltin;
  });
  if (overrides.length > 0) {
    log(
      'overriding built-in formation resource type(s): %s',
      overrides
        .map((registration) => {
          return registration.name;
        })
        .join(', ')
    );
  }

  log(
    'registered %d custom formation resource type(s): %s',
    registrations.length,
    registrations
      .map((registration) => {
        return registration.name;
      })
      .join(', ')
  );

  const disabledTypes = parseDisabledResourceTypes({
    config,
    builtInTypes: args.builtInTypes,
    registrations,
    source,
  });
  if (disabledTypes.size > 0) {
    log(
      'disabling built-in formation resource type(s): %s',
      [...disabledTypes].join(', ')
    );
  }

  return { registrations, disabledTypes };
};

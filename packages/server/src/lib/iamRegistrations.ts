/**
 * Deployment-registered IAM modules: the actions and resource types of routes
 * a deployment fronting SOAT serves itself, so its policies name them and
 * `POST /api/v1/iam/check` evaluates them with the runtime's engine.
 *
 * Loaded at boot from the JSON file `IAM_REGISTRATIONS_CONFIG` names, and
 * writable through no route: a registration widens what every policy may say,
 * which is deployment config, not a tenant's.
 */
import * as fs from 'node:fs';

import createDebug from 'debug';

import { isObjectRecord } from './openapiSchemaFields';
import { listModuleNames } from './permissionCatalog';

const log = createDebug('soat:iam:registrations');

export const IAM_REGISTRATIONS_CONFIG_ENV = 'IAM_REGISTRATIONS_CONFIG';

const MODULE_PATTERN = /^[a-z][a-z0-9-]*$/;
const OPERATION_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
/** Spelled like a built-in SRN type (`memory_store`). */
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;

export type IamModuleRegistration = {
  module: string;
  resourceTypes: ReadonlySet<string>;
  /** Action → description. */
  actions: ReadonlyMap<string, string>;
};

const fail = (args: { source: string; message: string }): never => {
  throw new Error(
    `Invalid IAM registrations config (${args.source}): ${args.message}`
  );
};

const parseResourceTypes = (args: {
  value: unknown;
  claimed: Map<string, string>;
  module: string;
  source: string;
  at: string;
}): Set<string> => {
  const { value, claimed, module, source, at } = args;
  if (!Array.isArray(value) || value.length === 0) {
    return fail({
      source,
      message: `${at}\`resource_types\` must be a non-empty array`,
    });
  }
  const parsed = new Set<string>();
  for (const type of value) {
    if (typeof type !== 'string' || !RESOURCE_TYPE_PATTERN.test(type)) {
      return fail({
        source,
        message: `${at}resource type '${String(type)}' must match ${RESOURCE_TYPE_PATTERN.source}`,
      });
    }
    const owner = claimed.get(type);
    if (owner !== undefined) {
      return fail({
        source,
        message: `${at}resource type '${type}' is already registered by '${owner}'`,
      });
    }
    claimed.set(type, module);
    parsed.add(type);
  }
  return parsed;
};

/** The action when it is `<module>:<Operation>`, else `undefined`. */
const readModuleAction = (args: {
  action: unknown;
  module: string;
}): string | undefined => {
  if (typeof args.action !== 'string') return undefined;
  const [prefix, operation, ...rest] = args.action.split(':');
  const valid =
    prefix === args.module &&
    rest.length === 0 &&
    OPERATION_PATTERN.test(operation ?? '');
  return valid ? args.action : undefined;
};

const parseActions = (args: {
  value: unknown;
  module: string;
  source: string;
  at: string;
}): Map<string, string> => {
  const { value, module, source, at } = args;
  if (!Array.isArray(value) || value.length === 0) {
    return fail({
      source,
      message: `${at}\`actions\` must be a non-empty array`,
    });
  }
  const parsed = new Map<string, string>();
  for (const entry of value) {
    const raw = isObjectRecord(entry) ? entry.action : undefined;
    const action = readModuleAction({ action: raw, module });
    if (action === undefined) {
      return fail({
        source,
        message: `${at}action '${String(raw)}' must be ${module}:<Operation>`,
      });
    }
    if (parsed.has(action)) {
      return fail({
        source,
        message: `${at}action '${action}' is declared more than once`,
      });
    }
    const description = isObjectRecord(entry) ? entry.description : undefined;
    parsed.set(action, typeof description === 'string' ? description : '');
  }
  return parsed;
};

/**
 * Parses and validates a registration file's contents. A module may not share
 * a built-in module's name: its `module:*` would then grant runtime actions.
 */
export const parseIamRegistrationConfig = (args: {
  config: unknown;
  source: string;
}): IamModuleRegistration[] => {
  const { config, source } = args;
  if (!isObjectRecord(config) || !Array.isArray(config.modules)) {
    return fail({ source, message: '`modules` must be an array' });
  }
  const builtIn = listModuleNames();
  const claimedTypes = new Map<string, string>();
  const seen = new Set<string>();
  return config.modules.map((entry, index) => {
    const at = `modules[${index}]: `;
    const module = isObjectRecord(entry) ? entry.module : undefined;
    if (typeof module !== 'string' || !MODULE_PATTERN.test(module)) {
      return fail({
        source,
        message: `${at}\`module\` must match ${MODULE_PATTERN.source}`,
      });
    }
    if (builtIn.has(module) || seen.has(module)) {
      return fail({
        source,
        message: `${at}module '${module}' is already ${builtIn.has(module) ? 'a built-in module' : 'declared'}`,
      });
    }
    seen.add(module);
    const record = isObjectRecord(entry) ? entry : {};
    return {
      module,
      resourceTypes: parseResourceTypes({
        value: record.resource_types,
        claimed: claimedTypes,
        module,
        source,
        at,
      }),
      actions: parseActions({ value: record.actions, module, source, at }),
    };
  });
};

const registered = new Map<string, IamModuleRegistration>();

export const registerIamModules = (args: {
  registrations: IamModuleRegistration[];
}): void => {
  for (const registration of args.registrations) {
    registered.set(registration.module, registration);
  }
};

/** Exists for tests, which must not leak a registry mutation into another file. */
export const unregisterIamModules = (args: { modules: string[] }): void => {
  for (const module of args.modules) registered.delete(module);
};

export const isRegisteredIamModule = (module: string): boolean => {
  return registered.has(module);
};

/** The registration declaring `action` exactly, if any. */
export const findIamActionRegistration = (
  action: string
): IamModuleRegistration | undefined => {
  const registration = registered.get(action.split(':')[0]);
  return registration?.actions.has(action) ? registration : undefined;
};

export const loadIamRegistrationConfig = (args: {
  env: Record<string, string | undefined>;
}): IamModuleRegistration[] => {
  const source = args.env[IAM_REGISTRATIONS_CONFIG_ENV];
  if (!source) return [];
  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(source, 'utf-8'));
  } catch (error) {
    throw new Error(
      `Could not load IAM registrations config (${source}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
  const registrations = parseIamRegistrationConfig({ config, source });
  log(
    'registered %d IAM module(s): %s',
    registrations.length,
    registrations
      .map((registration) => {
        return registration.module;
      })
      .join(', ')
  );
  return registrations;
};

/** Called once at boot; any problem throws, which fails the boot. */
export const initIamRegistrations = (): void => {
  registerIamModules({
    registrations: loadIamRegistrationConfig({ env: process.env }),
  });
};

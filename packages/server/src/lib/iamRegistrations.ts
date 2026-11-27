/**
 * Deployment-registered IAM modules: the actions and resource types of routes
 * a deployment fronting SOAT serves itself, on a project or on a project
 * group, so its policies name them and `POST /api/v1/iam/check` evaluates them
 * with the runtime's engine.
 *
 * Loaded at boot from the JSON file `IAM_REGISTRATIONS_CONFIG` names, and
 * writable through no route: a registration widens what every policy may say,
 * which is deployment config, not a tenant's.
 */
import * as fs from 'node:fs';

import createDebug from 'debug';

import { declareDenialCodes, parseDenialCodes } from '../errors';
import { isObjectRecord } from './openapiSchemaFields';
import { listModuleNames } from './permissionCatalog';
import {
  PROJECT_GROUP_ACTION_RESOURCE_TYPES,
  WHOLE_PROJECT_GROUP,
} from './projectGroupActions';

const log = createDebug('soat:iam:registrations');

export const IAM_REGISTRATIONS_CONFIG_ENV = 'IAM_REGISTRATIONS_CONFIG';

const MODULE_PATTERN = /^[a-z][a-z0-9-]*$/;
const OPERATION_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
/** Spelled like a built-in SRN type (`memory_store`). */
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;

export type IamProjectGroupAction = {
  /** Types on `srn:project-group:<project_group_id>:<type>/<id|*>`; `*` is the whole project group. */
  resourceTypes: ReadonlySet<string>;
  description: string;
};

export type IamModuleRegistration = {
  module: string;
  resourceTypes: ReadonlySet<string>;
  /** Action → description, each checked on a project's SRN. */
  actions: ReadonlyMap<string, string>;
  /** Action → what it is checked on, a project group's SRN. */
  projectGroupActions: ReadonlyMap<string, IamProjectGroupAction>;
};

const BUILT_IN_PROJECT_GROUP_TYPES: ReadonlySet<string> = new Set(
  Object.values(PROJECT_GROUP_ACTION_RESOURCE_TYPES)
    .flat()
    .filter((type) => {
      return type !== WHOLE_PROJECT_GROUP;
    })
);

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

/** The entry's action, refused unless it is `<module>:<Operation>` declared once. */
const readDeclaredAction = (args: {
  entry: unknown;
  module: string;
  declared: Set<string>;
  source: string;
  at: string;
}): string => {
  const { entry, module, declared, source, at } = args;
  const raw = isObjectRecord(entry) ? entry.action : undefined;
  const action = readModuleAction({ action: raw, module });
  if (action === undefined) {
    return fail({
      source,
      message: `${at}action '${String(raw)}' must be ${module}:<Operation>`,
    });
  }
  if (declared.has(action)) {
    return fail({
      source,
      message: `${at}action '${action}' is declared more than once`,
    });
  }
  declared.add(action);
  return action;
};

const descriptionOf = (entry: unknown): string => {
  const description = isObjectRecord(entry) ? entry.description : undefined;
  return typeof description === 'string' ? description : '';
};

const parseActions = (args: {
  value: unknown;
  module: string;
  declared: Set<string>;
  source: string;
  at: string;
}): Map<string, string> => {
  const { value, module, declared, source, at } = args;
  if (!Array.isArray(value) || value.length === 0) {
    return fail({
      source,
      message: `${at}\`actions\` must be a non-empty array`,
    });
  }
  const parsed = new Map<string, string>();
  for (const entry of value) {
    const action = readDeclaredAction({ entry, module, declared, source, at });
    parsed.set(action, descriptionOf(entry));
  }
  return parsed;
};

/**
 * Why `type` cannot be a registered project group type: a built-in project
 * group type stays the built-in actions', and each other type belongs to one
 * module. `null` when it can.
 */
const projectGroupTypeRefusal = (args: {
  type: unknown;
  claimed: ReadonlyMap<string, string>;
  module: string;
}): string | null => {
  const { type, claimed, module } = args;
  const valid =
    typeof type === 'string' &&
    (type === WHOLE_PROJECT_GROUP || RESOURCE_TYPE_PATTERN.test(type));
  if (!valid) {
    return `resource type '${String(type)}' must be '*' or match ${RESOURCE_TYPE_PATTERN.source}`;
  }
  if (BUILT_IN_PROJECT_GROUP_TYPES.has(type)) {
    return `resource type '${type}' is a built-in project group type`;
  }
  const owner = claimed.get(type);
  if (owner !== undefined && owner !== module) {
    return `project group resource type '${type}' is already registered by '${owner}'`;
  }
  return null;
};

const parseProjectGroupTypes = (args: {
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
    const refusal = projectGroupTypeRefusal({ type, claimed, module });
    if (refusal) return fail({ source, message: `${at}${refusal}` });
    claimed.set(String(type), module);
    parsed.add(String(type));
  }
  return parsed;
};

const parseProjectGroupActions = (args: {
  value: unknown;
  module: string;
  declared: Set<string>;
  claimed: Map<string, string>;
  source: string;
  at: string;
}): Map<string, IamProjectGroupAction> => {
  const { value, module, source, at } = args;
  if (!Array.isArray(value) || value.length === 0) {
    return fail({
      source,
      message: `${at}\`project_group_actions\` must be a non-empty array`,
    });
  }
  const parsed = new Map<string, IamProjectGroupAction>();
  for (const entry of value) {
    const action = readDeclaredAction({ ...args, entry });
    const resourceTypes = parseProjectGroupTypes({
      value: isObjectRecord(entry) ? entry.resource_types : undefined,
      claimed: args.claimed,
      module,
      source,
      at: `${at}action '${action}': `,
    });
    parsed.set(action, { resourceTypes, description: descriptionOf(entry) });
  }
  return parsed;
};

/** A module declares project actions, project group actions, or both. */
const parseModuleScopes = (args: {
  record: Record<string, unknown>;
  module: string;
  claimedTypes: Map<string, string>;
  claimedGroupTypes: Map<string, string>;
  source: string;
  at: string;
}): Omit<IamModuleRegistration, 'module'> => {
  const { record, module, source, at } = args;
  const declared = new Set<string>();
  const onProject =
    record.actions !== undefined || record.resource_types !== undefined;
  const onProjectGroup = record.project_group_actions !== undefined;
  if (!onProject && !onProjectGroup) {
    return fail({
      source,
      message: `${at}module '${module}' must declare \`actions\` or \`project_group_actions\``,
    });
  }
  return {
    resourceTypes: onProject
      ? parseResourceTypes({
          value: record.resource_types,
          claimed: args.claimedTypes,
          module,
          source,
          at,
        })
      : new Set(),
    actions: onProject
      ? parseActions({ value: record.actions, module, declared, source, at })
      : new Map(),
    projectGroupActions: onProjectGroup
      ? parseProjectGroupActions({
          value: record.project_group_actions,
          module,
          declared,
          claimed: args.claimedGroupTypes,
          source,
          at,
        })
      : new Map(),
  };
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
  const claimedGroupTypes = new Map<string, string>();
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
    return {
      module,
      ...parseModuleScopes({
        record: isObjectRecord(entry) ? entry : {},
        module,
        claimedTypes,
        claimedGroupTypes,
        source,
        at,
      }),
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

/** The registration declaring `action` exactly, on a project, if any. */
export const findIamActionRegistration = (
  action: string
): IamModuleRegistration | undefined => {
  const registration = registered.get(action.split(':')[0]);
  return registration?.actions.has(action) ? registration : undefined;
};

/**
 * The project group types `action` is checked on, built-in or registered;
 * `undefined` when it is no project group action. Every reader of which
 * actions are project group actions asks here.
 */
export const findProjectGroupActionResourceTypes = (
  action: string
): ReadonlySet<string> | undefined => {
  if (Object.hasOwn(PROJECT_GROUP_ACTION_RESOURCE_TYPES, action)) {
    return new Set(PROJECT_GROUP_ACTION_RESOURCE_TYPES[action]);
  }
  return registered.get(action.split(':')[0])?.projectGroupActions.get(action)
    ?.resourceTypes;
};

/** Every project group action, as the actions of a policy statement. */
export const listProjectGroupActionPatterns = (): string[] => {
  return [
    'project-groups:*',
    ...[...registered.values()].flatMap((registration) => {
      return [...registration.projectGroupActions.keys()];
    }),
  ];
};

/** The parsed `IAM_REGISTRATIONS_CONFIG` file, or `null` when none is named. */
export const readIamRegistrationFile = (args: {
  env: Record<string, string | undefined>;
}): { config: unknown; source: string } | null => {
  const source = args.env[IAM_REGISTRATIONS_CONFIG_ENV];
  if (!source) return null;
  try {
    return { config: JSON.parse(fs.readFileSync(source, 'utf-8')), source };
  } catch (error) {
    throw new Error(
      `Could not load IAM registrations config (${source}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
};

const registrationsIn = (file: {
  config: unknown;
  source: string;
}): IamModuleRegistration[] => {
  const registrations = parseIamRegistrationConfig(file);
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

export const loadIamRegistrationConfig = (args: {
  env: Record<string, string | undefined>;
}): IamModuleRegistration[] => {
  const file = readIamRegistrationFile(args);
  return file ? registrationsIn(file) : [];
};

/**
 * Called once at boot: registers the file's modules and declares its
 * `denial_codes`. Any problem throws, which fails the boot.
 */
export const initIamRegistrations = (): void => {
  const file = readIamRegistrationFile({ env: process.env });
  registerIamModules({ registrations: file ? registrationsIn(file) : [] });
  declareDenialCodes({ codes: file ? parseDenialCodes(file) : new Map() });
};

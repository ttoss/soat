/**
 * Operator-registered formation resource types.
 *
 * A deployment that fronts SOAT with its own product resources — a channel, a
 * routing rule — needs those to be declarable in a formation template without
 * either forking `formationsRegistry.ts` or rebuilding the deploy engine
 * downstream. A registration names such a type and points its lifecycle at an
 * external HTTP handler; ordering, `{ref}` resolution, rollback, recording and
 * drift stay here (#1078).
 *
 * ## Why this is deployment config and not an API
 *
 * The registration set is loaded from a JSON file named by
 * `FORMATION_RESOURCE_TYPES_CONFIG` at boot, and is not writable through any
 * route. Two properties follow, and both are the point:
 *
 * - **The operator owns it, not the tenant.** The handler URL and its signing
 *   secret sit at the same trust level as the database URL. No tenant input
 *   influences where the engine calls or how the call is signed.
 * - **A type exists uniformly in every project.** A per-project registration
 *   would make the same template valid in one project and invalid in the next,
 *   and would need a provisioning sweep for every project that already exists.
 *
 * The secret is referenced by variable *name* (`secret_env`), never inlined, so
 * the config file itself carries nothing confidential and can be baked into an
 * image or a config map.
 */

import * as fs from 'node:fs';

import createDebug from 'debug';

import type { SchemaFields, SchemaWithProperties } from './openapiSchemaFields';
import {
  deriveSchemaFields,
  hasProperties,
  isObjectRecord,
} from './openapiSchemaFields';

const log = createDebug('soat:formations:resourceTypes');

export const FORMATION_RESOURCE_TYPES_CONFIG_ENV =
  'FORMATION_RESOURCE_TYPES_CONFIG';

const DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * A type name is spelled like a built-in (`model_route`), because a template
 * author cannot tell the two apart and should not have to.
 */
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

// ── Capabilities ──────────────────────────────────────────────────────────

/**
 * The *optional* handler operations. `create`, `update` and `delete` are the
 * lifecycle itself and are always required, so they are never listed — a
 * registration declares only what it adds:
 *
 * - `validate` — a plan-time round trip for checks the JSON Schema cannot
 *   express. Without it, plan-time validation is the schema alone.
 * - `read` — the live-state read the drift contract is built on. Without it the
 *   type is exempt from drift detection, which the plan output says out loud
 *   rather than quietly reporting "no changes".
 */
export const HANDLER_CAPABILITIES = ['validate', 'read'] as const;

export type HandlerCapability = (typeof HANDLER_CAPABILITIES)[number];

const isHandlerCapability = (value: unknown): value is HandlerCapability => {
  return HANDLER_CAPABILITIES.includes(value as HandlerCapability);
};

// ── Registration ──────────────────────────────────────────────────────────

export type FormationHandlerConfig = {
  url: string;
  /** Resolved at boot from the variable `secret_env` names. */
  secret: string;
  timeoutMs: number;
};

export type FormationResourceTypeRegistration = {
  name: string;
  description?: string;
  handler: FormationHandlerConfig;
  capabilities: ReadonlySet<HandlerCapability>;
  /** The declared property schema, kept for the docs/plan surfaces. */
  schema: SchemaWithProperties;
  /** The field sets template validation is driven from. */
  schemaFields: SchemaFields;
};

// ── Parsing ───────────────────────────────────────────────────────────────

/**
 * Every rejection below is a hard boot failure. That is deliberate: a
 * registration that is half-valid would either publish a resource type whose
 * applies all fail, or — worse, for a missing secret — sign every request with
 * an empty key. Failing to start names the problem while someone is still
 * looking at the deploy.
 */
const fail = (args: { source: string; message: string }): never => {
  throw new Error(
    `Invalid formation resource type config (${args.source}): ${args.message}`
  );
};

/**
 * The signing secret, read from the variable the config file *names*. Resolved
 * at boot rather than per request, so a deployment whose secret is missing
 * fails to start instead of signing every handler call with an empty key.
 */
const resolveSecret = (args: {
  secretEnv: unknown;
  env: Record<string, string | undefined>;
  source: string;
  at: string;
}): string => {
  const { secretEnv, env, source, at } = args;
  if (typeof secretEnv !== 'string' || secretEnv.length === 0) {
    return fail({
      source,
      message: `${at}\`handler.secret_env\` must be a string naming an environment variable`,
    });
  }

  const secret = env[secretEnv];
  if (typeof secret !== 'string' || secret.length === 0) {
    return fail({
      source,
      message: `${at}environment variable \`${secretEnv}\` is not set or is empty`,
    });
  }
  return secret;
};

const parseHandler = (args: {
  handler: unknown;
  env: Record<string, string | undefined>;
  source: string;
  at: string;
}): FormationHandlerConfig => {
  const { handler, env, source, at } = args;
  if (!isObjectRecord(handler)) {
    return fail({ source, message: `${at}\`handler\` must be an object` });
  }

  const url = handler.url;
  if (typeof url !== 'string' || !/^https?:\/\/\S+$/.test(url)) {
    return fail({
      source,
      message: `${at}\`handler.url\` must be an http(s) URL`,
    });
  }

  const secret = resolveSecret({
    secretEnv: handler.secret_env,
    env,
    source,
    at,
  });

  const timeoutSeconds = handler.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (typeof timeoutSeconds !== 'number' || timeoutSeconds <= 0) {
    return fail({
      source,
      message: `${at}\`handler.timeout_seconds\` must be a positive number`,
    });
  }

  return { url, secret, timeoutMs: Math.round(timeoutSeconds * 1000) };
};

const parseCapabilities = (args: {
  capabilities: unknown;
  source: string;
  at: string;
}): Set<HandlerCapability> => {
  const { capabilities, source, at } = args;
  if (capabilities === undefined) return new Set();
  if (!Array.isArray(capabilities)) {
    return fail({ source, message: `${at}\`capabilities\` must be an array` });
  }

  const parsed = new Set<HandlerCapability>();
  for (const capability of capabilities) {
    if (!isHandlerCapability(capability)) {
      return fail({
        source,
        message: `${at}Unknown capability '${String(capability)}'. Allowed: ${HANDLER_CAPABILITIES.join(', ')}`,
      });
    }
    parsed.add(capability);
  }
  return parsed;
};

const parseEntry = (args: {
  entry: unknown;
  index: number;
  builtInTypes: ReadonlySet<string>;
  seen: Set<string>;
  env: Record<string, string | undefined>;
  source: string;
}): FormationResourceTypeRegistration => {
  const { entry, index, builtInTypes, seen, env, source } = args;
  const at = `resource_types[${index}]: `;

  if (!isObjectRecord(entry)) {
    return fail({ source, message: `${at}must be an object` });
  }

  const name = entry.name;
  if (typeof name !== 'string' || name.length === 0) {
    return fail({ source, message: `${at}\`name\` is required` });
  }
  if (!NAME_PATTERN.test(name)) {
    return fail({
      source,
      message: `${at}\`name\` must match ${NAME_PATTERN.source} — the same spelling built-in types use`,
    });
  }
  if (builtInTypes.has(name)) {
    // Shadowing a built-in would let deployment config silently redirect an
    // `agent` resource to an external handler.
    return fail({
      source,
      message: `${at}'${name}' is a built-in formation resource type and cannot be redefined`,
    });
  }
  if (seen.has(name)) {
    return fail({
      source,
      message: `${at}'${name}' is declared more than once`,
    });
  }

  const schema = entry.schema;
  if (!hasProperties(schema)) {
    return fail({
      source,
      message: `${at}\`schema\` must be an object schema with a \`properties\` map`,
    });
  }

  const description = entry.description;

  return {
    name,
    ...(typeof description === 'string' ? { description } : {}),
    handler: parseHandler({ handler: entry.handler, env, source, at }),
    capabilities: parseCapabilities({
      capabilities: entry.capabilities,
      source,
      at,
    }),
    schema,
    schemaFields: deriveSchemaFields({ schema }),
  };
};

/**
 * Parses and fully validates a registration file's contents. Pure over its
 * inputs — the environment and the built-in type set are passed in — so the
 * whole rejection table is reachable without a boot.
 */
export const parseFormationResourceTypeConfig = (args: {
  config: unknown;
  builtInTypes: ReadonlySet<string>;
  env: Record<string, string | undefined>;
  source: string;
}): FormationResourceTypeRegistration[] => {
  const { config, builtInTypes, env, source } = args;

  if (!isObjectRecord(config)) {
    return fail({ source, message: 'must be a JSON object' });
  }
  if (!Array.isArray(config.resource_types)) {
    return fail({ source, message: '`resource_types` must be an array' });
  }

  const seen = new Set<string>();
  const registrations: FormationResourceTypeRegistration[] = [];
  for (const [index, entry] of config.resource_types.entries()) {
    const registration = parseEntry({
      entry,
      index,
      builtInTypes,
      seen,
      env,
      source,
    });
    seen.add(registration.name);
    registrations.push(registration);
  }

  return registrations;
};

// ── Loading ───────────────────────────────────────────────────────────────

/**
 * Reads the registration file named by `FORMATION_RESOURCE_TYPES_CONFIG`, or
 * returns nothing when the variable is unset — the overwhelmingly common case,
 * and the one where a deployment must behave exactly as it did before this
 * existed.
 */
export const loadFormationResourceTypeConfig = (args: {
  builtInTypes: ReadonlySet<string>;
  env: Record<string, string | undefined>;
}): FormationResourceTypeRegistration[] => {
  const source = args.env[FORMATION_RESOURCE_TYPES_CONFIG_ENV];
  if (!source) return [];

  log('loading formation resource type registrations from %s', source);

  let raw: string;
  try {
    raw = fs.readFileSync(source, 'utf-8');
  } catch (error) {
    throw new Error(
      `Could not read formation resource type config (${source}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Could not parse formation resource type config (${source}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const registrations = parseFormationResourceTypeConfig({
    config,
    builtInTypes: args.builtInTypes,
    env: args.env,
    source,
  });

  log(
    'registered %d custom formation resource type(s): %s',
    registrations.length,
    registrations
      .map((registration) => {
        return registration.name;
      })
      .join(', ')
  );

  return registrations;
};

/**
 * The actions a `builtin` tool may name: the native actions a deployment
 * offers (`builtin_actions.allow` in the `IAM_REGISTRATIONS_CONFIG` file, all
 * when absent) and the actions it adds, served by its registered MCP server
 * (`builtin_actions.add`). Every site that reads a `builtin` action resolves
 * it through `findBuiltinAction`.
 */
import { readIamRegistrationFile } from './iamRegistrations';
import {
  assertMcpServerActionsCheckable,
  type DeclaredAction,
  type McpToolRegistration,
  parseMcpServerEntry,
} from './mcpToolRegistrations';
import { isObjectRecord } from './openapiSchemaFields';
import { soatTools, type ToolDefinition } from './soatTools';
import { isToolAssertionConfigured } from './toolAssertion';

export type BuiltinActionCatalog = {
  /** `null` offers every native action. */
  allow: ReadonlySet<string> | null;
  added: McpToolRegistration | null;
};

export type BuiltinAction =
  | { kind: 'native'; name: string; def: ToolDefinition }
  | {
      kind: 'added';
      name: string;
      url: string;
      declared: readonly DeclaredAction[];
    };

const NATIVE = new Map(
  soatTools.map((def) => {
    return [def.name, def];
  })
);

const EVERY_NATIVE_ACTION: BuiltinActionCatalog = { allow: null, added: null };

const fail = (args: { source: string; message: string }): never => {
  throw new Error(
    `Invalid IAM registrations config (${args.source}): ${args.message}`
  );
};

const parseAllow = (args: {
  value: unknown;
  source: string;
}): Set<string> | null => {
  const { value, source } = args;
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    return fail({
      source,
      message: '`builtin_actions.allow` must be an array',
    });
  }
  const allow = new Set<string>();
  for (const name of value) {
    if (typeof name !== 'string' || !NATIVE.has(name)) {
      return fail({
        source,
        message: `\`builtin_actions.allow\`: '${String(name)}' is not a native action`,
      });
    }
    allow.add(name);
  }
  return allow;
};

const parseAdded = (args: {
  value: unknown;
  source: string;
}): McpToolRegistration | null => {
  const { value, source } = args;
  if (value === undefined) return null;
  const added = parseMcpServerEntry({
    value,
    source,
    at: '`builtin_actions.add`',
  });
  for (const name of added.tools.keys()) {
    if (NATIVE.has(name)) {
      return fail({
        source,
        message: `\`builtin_actions.add\`: '${name}' is a native action`,
      });
    }
  }
  return added;
};

export const parseBuiltinActionCatalog = (args: {
  config: unknown;
  source: string;
}): BuiltinActionCatalog => {
  const { source } = args;
  const value = isObjectRecord(args.config)
    ? args.config.builtin_actions
    : undefined;
  if (value === undefined) return EVERY_NATIVE_ACTION;
  if (!isObjectRecord(value)) {
    return fail({ source, message: '`builtin_actions` must be an object' });
  }
  return {
    allow: parseAllow({ value: value.allow, source }),
    added: parseAdded({ value: value.add, source }),
  };
};

let catalog: BuiltinActionCatalog = EVERY_NATIVE_ACTION;

/**
 * Throws on an added action `iam/check` would not answer, or added actions
 * with no tool assertion to send them: their server acts only on one.
 */
export const registerBuiltinActionCatalog = (
  next: BuiltinActionCatalog
): void => {
  if (next.added) {
    assertMcpServerActionsCheckable(next.added);
    if (!isToolAssertionConfigured()) {
      throw new Error(
        '`builtin_actions.add` needs TOOL_ASSERTION_PRIVATE_KEY: an added action reaches its server only with a signed tool assertion'
      );
    }
  }
  catalog = next;
};

/** Exists for tests, which must not leak a catalog into another file. */
export const resetBuiltinActionCatalog = (): void => {
  catalog = EVERY_NATIVE_ACTION;
};

/** The name the model is offered one action of a `builtin` tool under. */
export const builtinActionToolName = (args: {
  toolName: string;
  action: string;
}): string => {
  return `${args.toolName}_${args.action}`;
};

export const isNativeAction = (name: string): boolean => {
  return NATIVE.has(name);
};

/** The action a `builtin` tool may name as `name`, or `undefined` when the deployment offers none. */
export const findBuiltinAction = (name: string): BuiltinAction | undefined => {
  const def = NATIVE.get(name);
  if (def) {
    return catalog.allow === null || catalog.allow.has(name)
      ? { kind: 'native', name, def }
      : undefined;
  }
  const declared = catalog.added?.tools.get(name);
  return declared && catalog.added
    ? { kind: 'added', name, url: catalog.added.url, declared }
    : undefined;
};

/** Called once at boot, after `initMcpToolRegistrations`; any problem fails the boot. */
export const initBuiltinActionCatalog = (): void => {
  const file = readIamRegistrationFile({ env: process.env });
  if (!file) return;
  registerBuiltinActionCatalog(parseBuiltinActionCatalog(file));
};

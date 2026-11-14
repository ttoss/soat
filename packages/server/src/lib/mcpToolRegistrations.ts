/**
 * MCP servers a deployment fronting the runtime serves itself, declared beside
 * its IAM modules (`mcp_tools` in the `IAM_REGISTRATIONS_CONFIG` file): for
 * each tool name the server serves, the actions calling it performs. An `mcp`
 * tool targeting one is held by the writer rule to those actions.
 */
import { assertDeclaredActionsCheckable } from './iamCheck';
import { readIamRegistrationFile } from './iamRegistrations';
import { isObjectRecord } from './openapiSchemaFields';

const ACTION_PATTERN = /^[a-z][a-z0-9-]*:[A-Z][A-Za-z0-9]*$/;
const RESOURCE_TYPE_PATTERN = /^[a-z][A-Za-z0-9_]*$/;

export type DeclaredAction = { action: string; resourceType: string };

export type McpToolRegistration = {
  url: string;
  /** Tool name → the actions calling it performs. */
  tools: ReadonlyMap<string, readonly DeclaredAction[]>;
};

const fail = (args: { source: string; message: string }): never => {
  throw new Error(
    `Invalid IAM registrations config (${args.source}): ${args.message}`
  );
};

/** Compared without a trailing slash, the one spelling difference that changes no target. */
export const normalizeMcpUrl = (url: string): string => {
  return url.replace(/\/+$/, '');
};

const parseDeclaredActions = (args: {
  value: unknown;
  source: string;
  at: string;
}): DeclaredAction[] => {
  const { value, source, at } = args;
  if (!Array.isArray(value) || value.length === 0) {
    return fail({ source, message: `${at} must be a non-empty array` });
  }
  return value.map((entry, index) => {
    const record = isObjectRecord(entry) ? entry : {};
    const { action, resource_type: resourceType } = record;
    if (typeof action !== 'string' || !ACTION_PATTERN.test(action)) {
      return fail({
        source,
        message: `${at}[${index}].action must be <module>:<Operation>`,
      });
    }
    if (
      typeof resourceType !== 'string' ||
      !RESOURCE_TYPE_PATTERN.test(resourceType)
    ) {
      return fail({
        source,
        message: `${at}[${index}].resource_type must be an SRN resource type`,
      });
    }
    return { action, resourceType };
  });
};

export const parseMcpToolRegistrations = (args: {
  config: unknown;
  source: string;
}): McpToolRegistration[] => {
  const { source } = args;
  const value = isObjectRecord(args.config) ? args.config.mcp_tools : undefined;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return fail({ source, message: '`mcp_tools` must be an array' });
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const at = `mcp_tools[${index}]`;
    const record = isObjectRecord(entry) ? entry : {};
    if (
      typeof record.url !== 'string' ||
      !/^https?:\/\/\S+$/.test(record.url)
    ) {
      return fail({ source, message: `${at}.url must be an http(s) URL` });
    }
    const url = normalizeMcpUrl(record.url);
    if (seen.has(url)) {
      return fail({
        source,
        message: `${at}: '${url}' is declared more than once`,
      });
    }
    seen.add(url);
    if (
      !isObjectRecord(record.tools) ||
      Object.keys(record.tools).length === 0
    ) {
      return fail({
        source,
        message: `${at}.tools must map each tool name to the actions it performs`,
      });
    }
    return {
      url,
      tools: new Map(
        Object.entries(record.tools).map(([name, actions]) => {
          return [
            name,
            parseDeclaredActions({
              value: actions,
              source,
              at: `${at}.tools.${name}`,
            }),
          ];
        })
      ),
    };
  });
};

const registered = new Map<string, McpToolRegistration>();

/** Throws on an action `iam/check` would not answer, so call it after the IAM modules are registered. */
export const registerMcpTools = (args: {
  registrations: McpToolRegistration[];
}): void => {
  for (const registration of args.registrations) {
    assertDeclaredActionsCheckable({
      owner: `MCP server ${registration.url}`,
      actions: [...registration.tools.values()].flat(),
    });
  }
  for (const registration of args.registrations) {
    registered.set(registration.url, registration);
  }
};

/** Exists for tests, which must not leak a registry mutation into another file. */
export const unregisterMcpTools = (args: { urls: string[] }): void => {
  for (const url of args.urls) registered.delete(normalizeMcpUrl(url));
};

export const findMcpToolRegistration = (
  url: string
): McpToolRegistration | undefined => {
  return registered.get(normalizeMcpUrl(url));
};

export const listMcpToolRegistrations = (): McpToolRegistration[] => {
  return [...registered.values()];
};

/** Called once at boot, after `initIamRegistrations`; any problem fails the boot. */
export const initMcpToolRegistrations = (): void => {
  const file = readIamRegistrationFile({ env: process.env });
  if (!file) return;
  registerMcpTools({ registrations: parseMcpToolRegistrations(file) });
};

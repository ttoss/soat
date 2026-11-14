/**
 * What a tool performs when called, as the writer rule asks it of whoever
 * writes the tool: a `builtin` tool its runtime actions; an `mcp` tool on a
 * registered MCP server what that server declares for each of its `actions`.
 */
import { DomainError } from '../errors';
import { BUILT_IN_ACTION_RESOURCE_TYPES } from './iamActionResourceTypes';
import { findMcpToolRegistration } from './mcpToolRegistrations';
import { resourceTypeOfKind } from './resourceScopes';
import { soatTools } from './soatTools';
import type { CarriedAction } from './writerRule';

export type CarriedTool = {
  type: string;
  mcp: object | null | undefined;
  actions: string[] | null | undefined;
};

const builtinActions = (actions: string[]): CarriedAction[] => {
  return actions.flatMap((name) => {
    const def = soatTools.find((tool) => {
      return tool.name === name;
    });
    if (!def) return [];
    const action = def.iamAction ?? name;
    const resourceType =
      (def.resource && resourceTypeOfKind({ kind: def.resource.kind })) ??
      BUILT_IN_ACTION_RESOURCE_TYPES[action.split(':')[0]]?.[0] ??
      '*';
    return [{ action, resourceType, resourceId: '*' }];
  });
};

const mcpUrlOf = (mcp: object | null | undefined): string | undefined => {
  const url = mcp && 'url' in mcp ? mcp.url : undefined;
  return typeof url === 'string' ? url : undefined;
};

const registeredMcpActions = (args: {
  url: string;
  actions: string[] | null | undefined;
}): CarriedAction[] => {
  const registration = findMcpToolRegistration(args.url);
  if (!registration) return [];
  if (!args.actions || args.actions.length === 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `A tool on ${registration.url} must list its \`actions\`: each is held by its writer.`
    );
  }
  return args.actions.flatMap((name) => {
    const declared = registration.tools.get(name);
    if (!declared) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `\`${name}\` is not a tool ${registration.url} declares.`
      );
    }
    return declared.map(({ action, resourceType }) => {
      return { action, resourceType, resourceId: '*' };
    });
  });
};

export const carriedActionsOfTool = (tool: CarriedTool): CarriedAction[] => {
  if (tool.type === 'builtin') return builtinActions(tool.actions ?? []);
  if (tool.type !== 'mcp') return [];
  const url = mcpUrlOf(tool.mcp);
  return url ? registeredMcpActions({ url, actions: tool.actions }) : [];
};

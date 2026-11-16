/**
 * What a tool performs when called, as the writer rule asks it of whoever
 * writes the tool: a `builtin` tool its native actions, and what the
 * deployment declares for each action it adds; an `mcp` tool on a
 * registered MCP server what that server declares for each of its `actions`;
 * a `pipeline` what each of its steps does.
 */
import { DomainError } from '../errors';
import { findBuiltinAction } from './builtinActionCatalog';
import { UNTYPED_BUILT_IN_MODULES } from './iamActionResourceTypes';
import { findMcpToolRegistration } from './mcpToolRegistrations';
import { validatePipelineConfig } from './pipelineTools';
import { type CarriedAction, startOf } from './writerRule';

export type CarriedTool = {
  type: string;
  mcp: object | null | undefined;
  actions: string[] | null | undefined;
  pipeline?: object | null;
};

/**
 * The type the action's route authorizes on; an untyped module's routes check
 * the whole project. Anything else declaring none is refused, never guessed.
 */
const writerResourceType = (args: {
  name: string;
  action: string;
  def: { iamResourceType?: string };
}): string => {
  if (args.def.iamResourceType) return args.def.iamResourceType;
  if (Object.hasOwn(UNTYPED_BUILT_IN_MODULES, args.action.split(':')[0])) {
    return '*';
  }
  throw new DomainError(
    'VALIDATION_FAILED',
    `\`${args.name}\` declares no resource type its route authorizes on.`
  );
};

const builtinActions = (actions: string[]): CarriedAction[] => {
  return actions.flatMap((name) => {
    const found = findBuiltinAction(name);
    if (!found) return [];
    if (found.kind === 'added') {
      return found.declared.map(({ action, resourceType }) => {
        return { action, resourceType, resourceId: '*' };
      });
    }
    const { def } = found;
    const action = def.iamAction ?? name;
    return [
      {
        action,
        resourceType: writerResourceType({ name, action, def }),
        resourceId: '*',
      },
    ];
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

/** A pipeline performs what each step does: its inline tool's actions, or calling the tool it names. */
const pipelineActions = (
  pipeline: object | null | undefined,
  carriedOf: (tool: CarriedTool) => CarriedAction[]
): CarriedAction[] => {
  return validatePipelineConfig(pipeline).steps.flatMap((step) => {
    if (step.tool) {
      return carriedOf({
        type: step.tool.type ?? 'http',
        mcp: step.tool.mcp,
        actions: step.tool.actions,
        pipeline: step.tool.pipeline,
      });
    }
    return step.toolId ? [startOf({ type: 'tool', id: step.toolId })] : [];
  });
};

export const carriedActionsOfTool = (tool: CarriedTool): CarriedAction[] => {
  if (tool.type === 'builtin') return builtinActions(tool.actions ?? []);
  if (tool.type === 'pipeline')
    return pipelineActions(tool.pipeline, carriedActionsOfTool);
  if (tool.type !== 'mcp') return [];
  const url = mcpUrlOf(tool.mcp);
  return url ? registeredMcpActions({ url, actions: tool.actions }) : [];
};

/**
 * `tool_choice`, `step_rules[].tool_choice` and a `has_tool_call` stop
 * condition name a tool by the name the model is offered it under
 * (`modules/tools.md` — Tool Name Resolution). A name the agent does not offer
 * fails the turn at the provider, or never stops it, so it is refused with the
 * names the agent does offer: on write where they are known without a listing,
 * and at generation start from the resolved surface.
 */
import { DomainError } from '../errors';
import {
  KNOWLEDGE_BINDING_NAME,
  readKnowledgeConfig,
  WRITE_MEMORY_TOOL_NAME,
} from './agentKnowledgeConfig';
import { normalizeToolChoice } from './agentStepRules';
import { type AgentToolBinding, splitToolBindings } from './agentToolBindings';
import { assignBindingToolNames } from './agentToolNames';
import { narrowToActiveTools } from './agentToolSelection';
import {
  builtinActionToolName,
  findBuiltinAction,
} from './builtinActionCatalog';
import { isPlainObject } from './plainObject';
import { toolReferences } from './resourceReferences';
import { withoutAgentExcludedActions } from './soatAgentActions';

type NamedTool = { field: string; name: string };

const choiceName = (toolChoice: unknown): string | null => {
  const choice = normalizeToolChoice(toolChoice);
  return typeof choice === 'object' ? choice.toolName : null;
};

const stepRuleNames = (stepRules: unknown): NamedTool[] => {
  if (!Array.isArray(stepRules)) return [];
  return stepRules.flatMap((rule) => {
    const name = isPlainObject(rule) ? choiceName(rule.tool_choice) : null;
    return name ? [{ field: 'step_rules[].tool_choice', name }] : [];
  });
};

const stopConditionNames = (stopConditions: unknown): NamedTool[] => {
  if (!Array.isArray(stopConditions)) return [];
  return stopConditions.flatMap((condition) => {
    return isPlainObject(condition) &&
      condition.type === 'has_tool_call' &&
      typeof condition.tool_name === 'string'
      ? [{ field: 'stop_conditions', name: condition.tool_name }]
      : [];
  });
};

const namedTools = (args: {
  toolChoice: unknown;
  stopConditions: unknown;
  stepRules: unknown;
}): NamedTool[] => {
  const forced = choiceName(args.toolChoice);
  return [
    ...(forced ? [{ field: 'tool_choice', name: forced }] : []),
    ...stepRuleNames(args.stepRules),
    ...stopConditionNames(args.stopConditions),
  ];
};

export const assertNamedToolsOffered = (args: {
  toolChoice: unknown;
  stopConditions: unknown;
  stepRules: unknown;
  offered: string[];
}): void => {
  const offered = new Set(args.offered);
  const missing = namedTools(args).find((named) => {
    return !offered.has(named.name);
  });
  if (!missing) return;
  throw new DomainError(
    'AGENT_TOOL_NOT_OFFERED',
    `${missing.field} names tool '${missing.name}', which the agent does not offer. Tools it offers: ${args.offered.length > 0 ? args.offered.join(', ') : 'none'}.`,
    {
      field: missing.field,
      tool_name: missing.name,
      offered_tool_names: args.offered,
    }
  );
};

/**
 * The generation-start check, against the surface the turn resolved. A binding
 * unreachable for the turn has unknown names, so its turn runs on the note.
 */
export const assertSurfaceOffersNamedTools = (args: {
  typedAgent: {
    toolChoice: unknown;
    stopConditions: unknown;
    stepRules: unknown;
  };
  toolSurface: {
    tools: Record<string, unknown>;
    unavailableToolNames: string[];
  };
}): void => {
  if (args.toolSurface.unavailableToolNames.length > 0) return;
  assertNamedToolsOffered({
    toolChoice: args.typedAgent.toolChoice,
    stopConditions: args.typedAgent.stopConditions,
    stepRules: args.typedAgent.stepRules,
    offered: Object.keys(args.toolSurface.tools),
  });
};

type ToolShape = {
  type?: string | null;
  name: string;
  actions?: string[] | null;
};

/**
 * The keys one binding resolves to, as the resolver keys them; `null` when only
 * the tool's server listing knows them (`mcp`).
 */
const bindingKeys = (tool: ToolShape): string[] | null => {
  switch (tool.type ?? 'http') {
    case 'http':
    case 'client':
    case 'pipeline':
      return [tool.name];
    case 'mcp':
      return null;
    case 'builtin': {
      const actions = tool.actions ?? [];
      const native = withoutAgentExcludedActions({
        actions,
        toolName: tool.name,
      }).filter((action) => {
        return findBuiltinAction(action)?.kind === 'native';
      });
      const added = actions.filter((action) => {
        return findBuiltinAction(action)?.kind === 'added';
      });
      return [...native, ...added].map((action) => {
        return builtinActionToolName({ toolName: tool.name, action });
      });
    }
    default:
      return [];
  }
};

/**
 * The names an agent's tools are offered under, or `null` when a binding's
 * names are only known from a listing or its tool is out of reach.
 */
export const knownOfferedToolNames = async (args: {
  projectId: number;
  toolBindings: AgentToolBinding[] | null;
  activeToolIds: unknown;
  knowledgeConfig: unknown;
}): Promise<string[] | null> => {
  const bound = splitToolBindings(args.toolBindings);
  const toolIds = narrowToActiveTools({
    toolIds: bound.toolIds,
    activeToolIds: args.activeToolIds,
  });
  const rows = await toolReferences.findMany({
    ids: toolIds,
    projectId: args.projectId,
    reach: 'shares',
  });

  const shapes: ToolShape[] = [];
  for (const id of toolIds) {
    const row = rows.get(id);
    if (!row) return null;
    shapes.push(row);
  }
  shapes.push(...bound.tools);

  const bindings: Array<{ bindingName: string; keys: string[] }> = [];
  for (const shape of shapes) {
    const keys = bindingKeys(shape);
    if (!keys) return null;
    bindings.push({ bindingName: shape.name, keys });
  }
  if (readKnowledgeConfig(args.knowledgeConfig)?.writeMemoryStoreId) {
    bindings.push({
      bindingName: KNOWLEDGE_BINDING_NAME,
      keys: [WRITE_MEMORY_TOOL_NAME],
    });
  }
  return assignBindingToolNames({ bindings }).flat();
};

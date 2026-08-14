/**
 * `step_rules` — the per-step `tool_choice` / `active_tool_ids` overrides an
 * agent can declare (`modules/agents.md` — Step Rules, #809) — compiled into
 * the AI SDK's `prepareStep` callback.
 *
 * `buildPrepareStep` existed twice: a private copy in `agentGenerationHelpers`
 * that hardcoded `(stream)` in its log lines, and an exported copy in
 * `agentNonStreamGeneration` that took the log context as a parameter — the
 * second being literally the generalization of the first, with the `StepRule`
 * type declared verbatim in both. The duplication existed only because the
 * helper module could not import the non-stream module (the non-stream module
 * imports it), so the rule lives in this leaf instead and both call it.
 */
import type { Tool, ToolChoice } from 'ai';
import createDebug from 'debug';

import type { TypedAgent } from './agentGenerationTypes';
import { resolveToolIdsToNames } from './agentToolSelection';

const log = createDebug('soat:generation');

/** One persisted rule, in the wire spelling every caller sends and stores. */
export type StepRule = {
  step: number;
  tool_choice?: unknown;
  active_tool_ids?: unknown;
};

// `tool_choice` (agent-level and inside `step_rules`) is stored verbatim from
// the request body, so the object form arrives wire-shaped:
// { type: "tool", tool_name: "..." }. The AI SDK expects
// { type: "tool", toolName: "..." } — this is the single translation point.
export const normalizeToolChoice = (
  value: unknown
):
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'tool'; toolName: string }
  | undefined => {
  if (value === 'auto' || value === 'required' || value === 'none') {
    return value;
  }
  if (value && typeof value === 'object') {
    const record = value as { type?: unknown; tool_name?: unknown };
    if (record.type === 'tool' && typeof record.tool_name === 'string') {
      return { type: 'tool', toolName: record.tool_name };
    }
  }
  return undefined;
};

/**
 * Every tool id named by any rule's `active_tool_ids`, deduped. This is the
 * set `resolveToolIdsToNames` needs resolved to names before `buildPrepareStep`
 * can honor a step-level restriction — the AI SDK's `activeTools` option is
 * keyed by tool name, the persisted rule holds tool ids.
 */
export const collectStepRuleActiveToolIds = (stepRules: unknown): string[] => {
  if (!Array.isArray(stepRules)) return [];
  const ids = new Set<string>();
  for (const rule of stepRules as StepRule[]) {
    const ruleIds = rule?.active_tool_ids;
    if (!Array.isArray(ruleIds)) continue;
    for (const id of ruleIds) {
      if (typeof id === 'string') ids.add(id);
    }
  }
  return [...ids];
};

/**
 * Translates a single rule's `active_tool_ids` (tool ids) into the tool names
 * `activeTools` expects, via the id→name map `collectStepRuleActiveToolIds` +
 * `resolveToolIdsToNames` produced. Returns `undefined` — "no restriction from
 * this rule" — when the field is absent/empty/not-an-array, or when every id
 * fails to resolve (mirrors `narrowToActiveTools`'s fail-open stance: an
 * unresolvable restriction is never read as "make no tools active").
 */
export const resolveStepActiveTools = (args: {
  activeToolIds: unknown;
  toolIdToName: Record<string, string>;
}): string[] | undefined => {
  if (!Array.isArray(args.activeToolIds) || args.activeToolIds.length === 0) {
    return undefined;
  }
  const names = args.activeToolIds
    .filter((id): id is string => {
      return typeof id === 'string';
    })
    .map((id) => {
      return args.toolIdToName[id];
    })
    .filter((name): name is string => {
      return typeof name === 'string';
    });
  return names.length > 0 ? names : undefined;
};

/**
 * Combines a rule's normalized `tool_choice` and resolved `active_tool_ids`
 * into the shape `prepareStep` returns. Split out of `buildPrepareStep`'s
 * closure so the closure body stays a thin log-and-delegate wrapper.
 */
export const resolvePrepareStepResult = (args: {
  ruleToolChoice: ReturnType<typeof normalizeToolChoice>;
  ruleActiveTools: string[] | undefined;
}): {
  toolChoice?: ToolChoice<Record<string, Tool>>;
  activeTools?: string[];
} => {
  const { ruleToolChoice, ruleActiveTools } = args;
  if (ruleToolChoice === undefined) {
    return ruleActiveTools ? { activeTools: ruleActiveTools } : {};
  }
  if (typeof ruleToolChoice === 'object' && ruleToolChoice.type === 'tool') {
    return {
      toolChoice: ruleToolChoice,
      activeTools: ruleActiveTools ?? [ruleToolChoice.toolName],
    };
  }
  // A string choice ('auto' | 'required' | 'none') overrides the agent's own
  // tool_choice for this step; no tool is named, so the active tool set is
  // only narrowed if the rule also sets active_tool_ids.
  return ruleActiveTools
    ? { toolChoice: ruleToolChoice, activeTools: ruleActiveTools }
    : { toolChoice: ruleToolChoice };
};

/**
 * Resolves the id→name map `buildPrepareStep` needs for a set of `step_rules`,
 * skipping the DB round trip when no rule names any tool id.
 */
export const resolveStepRuleToolIdToName = async (args: {
  stepRules: unknown;
  projectId: number;
}): Promise<Record<string, string>> => {
  const stepRuleToolIds = collectStepRuleActiveToolIds(args.stepRules);
  if (stepRuleToolIds.length === 0) return {};
  return resolveToolIdsToNames({
    toolIds: stepRuleToolIds,
    projectId: args.projectId,
  });
};

/** {@link resolveStepRuleToolIdToName} for a whole agent config. */
export const resolveAgentStepRuleToolIdToName = async (
  typedAgent: TypedAgent
): Promise<Record<string, string>> => {
  return resolveStepRuleToolIdToName({
    stepRules: typedAgent.stepRules,
    projectId: typedAgent.project.id as number,
  });
};

export const buildPrepareStep = (args: {
  stepRules: unknown;
  logContext: 'stream' | 'non_stream';
  toolIdToName?: Record<string, string>;
}):
  | ((opts: { stepNumber: number }) => {
      toolChoice?: ToolChoice<Record<string, Tool>>;
      activeTools?: string[];
    })
  | undefined => {
  if (!Array.isArray(args.stepRules) || args.stepRules.length === 0) {
    return undefined;
  }

  const rules = args.stepRules as StepRule[];
  const toolIdToName = args.toolIdToName ?? {};
  log('buildPrepareStep (%s): rules=%o', args.logContext, rules);

  return ({ stepNumber }) => {
    // stepNumber is 0-based (AI SDK), step_rules use 1-indexed steps.
    const oneIndexedStep = stepNumber + 1;
    const rule = rules.find((candidate) => {
      return candidate.step === oneIndexedStep;
    });

    log(
      'prepareStep (%s): stepNumber=%d (1-indexed=%d) rule=%o',
      args.logContext,
      stepNumber,
      oneIndexedStep,
      rule
    );

    const result = resolvePrepareStepResult({
      ruleToolChoice: normalizeToolChoice(rule?.tool_choice),
      ruleActiveTools: resolveStepActiveTools({
        activeToolIds: rule?.active_tool_ids,
        toolIdToName,
      }),
    });
    log('prepareStep (%s): result=%o', args.logContext, result);
    return result;
  };
};

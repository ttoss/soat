import crypto from 'node:crypto';

import type { Tool } from 'ai';
import { jsonSchema } from 'ai';
import createDebug from 'debug';

import type {
  AgentToolBinding,
  ToolApprovalEffect,
  ToolApprovalPolicy,
} from './agentToolBindings';
import { emitApproval } from './approvals';
import { evaluateLogic } from './jsonLogicMapping';

const log = createDebug('soat:agents');

// Absent an `expires_in` on the policy, a tool-call approval defaults to a 24h
// window — the same default the `approval` orchestration node uses, so both
// producers behave identically (agents.md — Approval Policy).
export const DEFAULT_TOOL_APPROVAL_EXPIRES_IN_SECONDS = 24 * 60 * 60;

// The additive, model-visible fields the agent may supply to justify a guarded
// call. Stripped from the executed arguments and frozen onto the approval item
// (prd-approvals.md §5). Kept in one place so the strip and the schema
// injection can never drift.
export const APPROVAL_JUSTIFICATION_FIELDS = [
  'approval_reasoning',
  'approval_evidence',
  'approval_predicted_impact',
] as const;

const DEFAULT_REASONING_PROMPT =
  'This action requires human approval before it executes. Explain why it is warranted.';

/**
 * The per-generation context the tool-dispatch approval gate needs to freeze an
 * item and route its eventual continuation. Built at the generation entry point
 * (where the agent, generation, project, and session are all known) and threaded
 * into the resolver — never assembled inside the resolver, to keep the
 * resolver → approvals dependency one-directional and cycle-free.
 */
export type ResolverApprovalContext = {
  agentId: string;
  generationId: string;
  projectId: number;
  sessionId?: string | null;
  // Approval policy per persisted-tool binding, keyed by tool publicId.
  policyByToolId: Record<string, ToolApprovalPolicy | null>;
  // Approval policy per inline binding, parallel to the resolver's `tools[]`.
  inlinePolicies: (ToolApprovalPolicy | null)[];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * Builds the resolver approval context from an agent's canonical bindings, or
 * `undefined` when no binding carries a policy — the resolver then skips the
 * gate entirely, so approval interception is zero-overhead for agents that
 * declare none. `policyByToolId` keys reference bindings by tool publicId;
 * `inlinePolicies` is positional over the inline bindings, matching the order
 * `deriveLegacyToolFields` feeds inline `tools[]` to the resolver.
 */
export const buildResolverApprovalContext = (args: {
  bindings: AgentToolBinding[] | null;
  agentId: string;
  generationId: string;
  projectId: number;
  sessionId?: string | null;
}): ResolverApprovalContext | undefined => {
  if (!args.bindings) return undefined;

  const policyByToolId: Record<string, ToolApprovalPolicy | null> = {};
  const inlinePolicies: (ToolApprovalPolicy | null)[] = [];
  for (const binding of args.bindings) {
    if (binding.tool) {
      inlinePolicies.push(binding.approvalPolicy ?? null);
    } else if (binding.toolId) {
      policyByToolId[binding.toolId] = binding.approvalPolicy ?? null;
    }
  }

  const hasPolicy =
    Object.values(policyByToolId).some(Boolean) || inlinePolicies.some(Boolean);
  if (!hasPolicy) return undefined;

  return {
    agentId: args.agentId,
    generationId: args.generationId,
    projectId: args.projectId,
    sessionId: args.sessionId ?? null,
    policyByToolId,
    inlinePolicies,
  };
};

// ── Policy evaluation ───────────────────────────────────────────────────────

/**
 * Evaluates a binding's approval policy for one resolved call. Rules are
 * first-match-wins over `{ action, arguments }` (the resolved action name plus
 * the call arguments, presets merged and justification fields stripped); the
 * `default` applies when no rule matches (prd-approvals.md §5). Evaluated by the
 * platform in the dispatch path — never by the model.
 */
export const evaluateApprovalEffect = (args: {
  policy: ToolApprovalPolicy;
  action: string;
  arguments: Record<string, unknown>;
}): ToolApprovalEffect => {
  for (const rule of args.policy.rules ?? []) {
    const matched = evaluateLogic(rule.when, {
      action: args.action,
      arguments: args.arguments,
    });
    // Plain JS truthiness, matching the JSON Logic convention used elsewhere
    // (e.g. orchestrationPollNode): `0`, `''`, `null`, and `NaN` are falsy, so
    // a rule whose `when` yields a falsy value does not fire.
    if (matched) {
      return rule.effect;
    }
  }
  return args.policy.default;
};

/**
 * Whether a policy can ever yield `require_approval` — the trigger for injecting
 * the justification fields into the model-visible schema. A policy that only
 * ever allows or denies never files an item, so it needs no justification
 * surface.
 */
export const policyCanRequireApproval = (
  policy: ToolApprovalPolicy
): boolean => {
  if (policy.default === 'require_approval') return true;
  return (policy.rules ?? []).some((rule) => {
    return rule.effect === 'require_approval';
  });
};

/**
 * The resolved action name a policy's `when` rules evaluate over, and the value
 * frozen onto the item for resolution-time execution. For `soat` tools each
 * action resolves to a `<toolName>_<action>` entry, so the action is recovered
 * by stripping the tool-name prefix; for `mcp` the entry key already *is* the
 * action; for every other type the key is the tool's own name.
 */
export const resolvedActionName = (args: {
  type: string;
  toolName: string;
  key: string;
}): string => {
  const prefix = `${args.toolName}_`;
  if (args.type === 'soat' && args.key.startsWith(prefix)) {
    return args.key.slice(prefix.length);
  }
  return args.key;
};

// ── Justification fields ────────────────────────────────────────────────────

/**
 * Splits the model-supplied arguments into the arguments actually executed
 * (justification fields removed) and the frozen justification the approver
 * sees. Supplied values of the wrong type degrade to `null` rather than
 * throwing — a stray non-string reasoning must never break tool dispatch.
 */
export const stripApprovalJustification = (
  modelArgs: Record<string, unknown>
): {
  cleanArgs: Record<string, unknown>;
  reasoning: string | null;
  evidence: object | null;
  predictedImpact: string | null;
} => {
  const {
    approval_reasoning: reasoning,
    approval_evidence: evidence,
    approval_predicted_impact: predictedImpact,
    ...cleanArgs
  } = modelArgs;
  return {
    cleanArgs,
    reasoning: typeof reasoning === 'string' ? reasoning : null,
    evidence: isPlainObject(evidence) ? evidence : null,
    predictedImpact:
      typeof predictedImpact === 'string' ? predictedImpact : null,
  };
};

/**
 * Adds the three optional justification fields to a tool's model-visible
 * parameters schema, the additive mirror of the `preset_parameters` surgery
 * that strips fields (prd-approvals.md §5). `reasoning_prompt` customizes the
 * guidance the model sees; a default is used when omitted. The fields stay
 * optional — never added to `required` — so a guarded call without justification
 * still validates.
 */
export const injectApprovalJustificationSchema = (
  schema: Record<string, unknown> | null | undefined,
  reasoningPrompt?: string | null
): Record<string, unknown> => {
  const base = isPlainObject(schema) ? schema : {};
  const properties = isPlainObject(base.properties) ? base.properties : {};
  const guidance = reasoningPrompt ?? DEFAULT_REASONING_PROMPT;
  return {
    ...base,
    type: 'object',
    properties: {
      ...properties,
      approval_reasoning: {
        type: 'string',
        description: `${guidance} Provide the reasoning for this action.`,
      },
      approval_evidence: {
        type: 'object',
        additionalProperties: true,
        description: 'Structured supporting evidence for the proposed action.',
      },
      approval_predicted_impact: {
        type: 'string',
        description: 'The expected effect of executing this action.',
      },
    },
  };
};

// ── Dedup ───────────────────────────────────────────────────────────────────

// Stable JSON: object keys sorted at every depth so semantically equal argument
// objects hash identically regardless of key order.
const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => {
        return `${JSON.stringify(key)}:${stableStringify(value[key])}`;
      })
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/**
 * The dedup key for a tool-call proposal: while a matching item is `pending`, a
 * re-proposal returns the existing item instead of filing a second (§3 Phase 2).
 * Keyed by project, proposing agent, tool, action, and the resolved arguments.
 */
export const computeToolCallDedupKey = (args: {
  projectId: number;
  agentId: string;
  toolId: string;
  action: string;
  arguments: Record<string, unknown>;
}): string => {
  const canonical = stableStringify({
    projectId: args.projectId,
    agentId: args.agentId,
    toolId: args.toolId,
    action: args.action,
    arguments: args.arguments,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

// ── Dispatch-path gate ──────────────────────────────────────────────────────

const toIso = (value: unknown): string => {
  return value instanceof Date ? value.toISOString() : String(value);
};

/**
 * Wraps one resolved tool's `execute` with the allow / require-approval / deny
 * gate. `allow` runs the tool with the justification fields stripped; `deny`
 * returns a structured refusal without executing; `require_approval` freezes the
 * proposal into an approval item (`origin: tool_call`) and returns a
 * `pending_approval` tool result — the generation completes its turn normally
 * (return-pending, §4.2). No execution happens on deny or require_approval, so
 * the tool's output mapping (already wrapped underneath) never runs for them.
 */
const buildGatedExecute = (args: {
  originalExecute: NonNullable<Tool['execute']>;
  policy: ToolApprovalPolicy;
  action: string;
  toolId: string;
  presetParameters?: Record<string, unknown> | null;
  context: ResolverApprovalContext;
}): NonNullable<Tool['execute']> => {
  return async (...executeArgs) => {
    const modelArgs = isPlainObject(executeArgs[0]) ? executeArgs[0] : {};
    const { cleanArgs, reasoning, evidence, predictedImpact } =
      stripApprovalJustification(modelArgs);
    const effectiveArgs = {
      ...(args.presetParameters ?? {}),
      ...cleanArgs,
    };

    const effect = evaluateApprovalEffect({
      policy: args.policy,
      action: args.action,
      arguments: effectiveArgs,
    });
    log(
      'approval gate: action=%s effect=%s toolId=%s',
      args.action,
      effect,
      args.toolId
    );

    if (effect === 'deny') {
      return { status: 'denied', reason: 'Denied by approval_policy.' };
    }
    if (effect === 'allow') {
      const [, ...rest] = executeArgs;
      return args.originalExecute(cleanArgs, ...rest);
    }

    const expiresInSeconds =
      typeof args.policy.expiresIn === 'number' && args.policy.expiresIn > 0
        ? args.policy.expiresIn
        : DEFAULT_TOOL_APPROVAL_EXPIRES_IN_SECONDS;
    // Freeze the effective (preset-merged) arguments the policy evaluated — not
    // the bare model args — so the approver sees the full call and the platform
    // re-executes exactly what was decided at resolution time.
    const dedupKey = computeToolCallDedupKey({
      projectId: args.context.projectId,
      agentId: args.context.agentId,
      toolId: args.toolId,
      action: args.action,
      arguments: effectiveArgs,
    });
    const item = await emitApproval({
      projectId: args.context.projectId,
      origin: 'tool_call',
      proposedAction: {
        toolId: args.toolId,
        action: args.action,
        arguments: effectiveArgs,
      },
      reasoning,
      evidence,
      predictedImpact,
      expiresInSeconds,
      dedupKey,
      generationId: args.context.generationId,
      agentId: args.context.agentId,
      sessionId: args.context.sessionId ?? null,
    });
    return {
      status: 'pending_approval',
      approval_id: item.id,
      expires_at: toIso(item.expiresAt),
    };
  };
};

/**
 * Applies a binding's approval policy to every resolved tool it produced (one
 * for most types; many for `mcp`/`soat`). Each entry's `execute` is gated; when
 * the policy can require approval and the caller supplies the tool's parameter
 * schema (`rawParameters` — set for `http`/`pipeline` and inline `http` tools),
 * the justification fields are added to the model-visible schema. `client`
 * bindings never carry a policy (rejected at write time) and have no `execute`,
 * so they pass through untouched.
 */
export const gateResolvedTools = (args: {
  tools: Record<string, Tool>;
  policy: ToolApprovalPolicy;
  toolId: string;
  toolType: string;
  toolName: string;
  presetParameters?: Record<string, unknown> | null;
  rawParameters?: Record<string, unknown> | null;
  context: ResolverApprovalContext;
}): Record<string, Tool> => {
  const canRequire = policyCanRequireApproval(args.policy);
  const gated: Record<string, Tool> = {};

  for (const [key, resolvedTool] of Object.entries(args.tools)) {
    if (!resolvedTool.execute) {
      gated[key] = resolvedTool;
      continue;
    }
    const action = resolvedActionName({
      type: args.toolType,
      toolName: args.toolName,
      key,
    });
    const gatedExecute = buildGatedExecute({
      originalExecute: resolvedTool.execute,
      policy: args.policy,
      action,
      toolId: args.toolId,
      presetParameters: args.presetParameters,
      context: args.context,
    });

    const injectSchema = canRequire && args.rawParameters !== undefined;
    // Spread the resolved tool in both branches so any property beyond the
    // three we set here (provider options, toModelOutput, …) survives gating.
    gated[key] = injectSchema
      ? {
          ...resolvedTool,
          inputSchema: jsonSchema(
            injectApprovalJustificationSchema(
              args.rawParameters,
              args.policy.reasoningPrompt
            )
          ),
          execute: gatedExecute,
        }
      : { ...resolvedTool, execute: gatedExecute };
  }

  return gated;
};

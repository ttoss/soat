import crypto from 'node:crypto';

// Shared tool-dispatch machinery for filing a tool-call approval item:
// return-pending justification fields, the resolved action name, the dedup key,
// and the default expiry. These helpers are used solely by the guardrail
// interceptor (`agentToolGuardrail.ts`) when a class-C guardrail files an
// approval — guardrails are the single tool-call gating mechanism.

// Absent an `expires_in` on the caller, a tool-call approval defaults to a 24h
// window — the same default the `approval` orchestration node uses, so both
// producers behave identically.
export const DEFAULT_TOOL_APPROVAL_EXPIRES_IN_SECONDS = 24 * 60 * 60;

const DEFAULT_REASONING_PROMPT =
  'This action requires human approval before it executes. Explain why it is warranted.';

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

// ── Resolved action name ──────────────────────────────────────────────────────

/**
 * The resolved action name frozen onto the item for resolution-time execution.
 * For `soat` tools each action resolves to a `<toolName>_<action>` entry, so the
 * action is recovered by stripping the tool-name prefix; for `mcp` the entry key
 * already *is* the action; for every other type the key is the tool's own name.
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

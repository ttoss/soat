import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  assertEphemeralTypeSupported,
  type InlineToolDefinition,
  validateToolDefinition,
} from './tools';

const log = createDebug('soat:agents');

// ── Types ─────────────────────────────────────────────────────────────────

export type ToolApprovalEffect = 'allow' | 'require_approval' | 'deny';

const APPROVAL_EFFECTS: readonly string[] = [
  'allow',
  'require_approval',
  'deny',
];

/**
 * The allow / require-approval / deny gate carried by a tool binding,
 * evaluated by the platform in the tool-dispatch path on every call of the
 * bound tool (prd-approvals.md §5).
 */
export type ToolApprovalPolicy = {
  default: ToolApprovalEffect;
  rules?: { when: Record<string, unknown>; effect: ToolApprovalEffect }[];
  expiresIn?: number;
  reasoningPrompt?: string | null;
};

/**
 * One entry of an agent's canonical `tool_bindings` — a persisted-tool
 * reference (`toolId`) or an inline definition (`tool`), never both, plus the
 * binding-scoped `approvalPolicy`. Mirrors the pipeline `steps[]`
 * reference-or-inline pattern.
 */
export type AgentToolBinding = {
  toolId?: string;
  tool?: InlineToolDefinition;
  approvalPolicy?: ToolApprovalPolicy | null;
};

/** The subset of an Agent row the binding helpers read. */
type AgentToolColumns = {
  toolBindings?: unknown;
  toolIds?: unknown;
  tools?: unknown;
};

// ── Read / derive ─────────────────────────────────────────────────────────

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * Derives canonical bindings from the deprecated `toolIds` / `tools` pair —
 * reference entries first, inline entries after (the only stable order the
 * two-array storage ever implied).
 */
export const bindingsFromLegacyFields = (args: {
  toolIds?: string[] | null;
  tools?: InlineToolDefinition[] | null;
}): AgentToolBinding[] | null => {
  const refs = (args.toolIds ?? []).map((toolId): AgentToolBinding => {
    return { toolId };
  });
  const inline = (args.tools ?? []).map((tool): AgentToolBinding => {
    return { tool };
  });
  const bindings = [...refs, ...inline];
  return bindings.length > 0 ? bindings : null;
};

/**
 * Reads an agent row's canonical tool bindings. Rows written since
 * `toolBindings` exists carry the canonical column; rows created before it
 * (legacy `toolIds`/`tools` columns only) are normalized lazily here, so no
 * data migration is needed.
 */
export const readAgentToolBindings = (
  row: AgentToolColumns
): AgentToolBinding[] | null => {
  if (Array.isArray(row.toolBindings)) {
    return row.toolBindings as AgentToolBinding[];
  }
  return bindingsFromLegacyFields({
    toolIds: (row.toolIds as string[] | null) ?? null,
    tools: (row.tools as InlineToolDefinition[] | null) ?? null,
  });
};

/**
 * Derives the deprecated `toolIds` / `tools` response views from canonical
 * bindings, preserving the old "unset" semantics: a side with no entries maps
 * to `null`, not `[]`.
 *
 * Ordering invariant: the inline `tools` array is emitted in binding order.
 * `buildResolverApprovalContext` builds its positional `inlinePolicies` from the
 * same binding order, so the two must stay in lockstep — the resolver pairs each
 * inline tool with the policy at the same index.
 */
export const deriveLegacyToolFields = (
  bindings: AgentToolBinding[] | null
): {
  toolIds: string[] | null;
  tools: InlineToolDefinition[] | null;
} => {
  if (!bindings) return { toolIds: null, tools: null };

  const toolIds = bindings.flatMap((binding) => {
    return binding.toolId ? [binding.toolId] : [];
  });
  const tools = bindings.flatMap((binding) => {
    return binding.tool ? [binding.tool] : [];
  });
  return {
    toolIds: toolIds.length > 0 ? toolIds : null,
    tools: tools.length > 0 ? tools : null,
  };
};

// ── Validation ────────────────────────────────────────────────────────────

const isApprovalEffect = (value: unknown): boolean => {
  return typeof value === 'string' && APPROVAL_EFFECTS.includes(value);
};

const validatePolicyRules = (rules: unknown): void => {
  if (rules === undefined) return;
  if (!Array.isArray(rules)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'approval_policy.rules must be an array.'
    );
  }
  for (const rule of rules) {
    if (!isPlainObject(rule) || !isPlainObject(rule.when)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'Each approval_policy rule requires a JSON Logic `when` object.'
      );
    }
    if (!isApprovalEffect(rule.effect)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        "Each approval_policy rule requires an effect of 'allow', 'require_approval', or 'deny'."
      );
    }
  }
};

const validatePolicyExpiresIn = (expiresIn: unknown): void => {
  if (expiresIn === undefined) return;
  if (
    typeof expiresIn !== 'number' ||
    !Number.isInteger(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'approval_policy.expires_in must be a positive integer (seconds).'
    );
  }
};

const validatePolicyReasoningPrompt = (reasoningPrompt: unknown): void => {
  if (reasoningPrompt === undefined || reasoningPrompt === null) return;
  if (typeof reasoningPrompt !== 'string') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'approval_policy.reasoning_prompt must be a string.'
    );
  }
};

const validateApprovalPolicyShape = (policy: unknown): ToolApprovalPolicy => {
  if (!isPlainObject(policy)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'approval_policy must be an object.'
    );
  }
  if (!isApprovalEffect(policy.default)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      "approval_policy.default is required and must be 'allow', 'require_approval', or 'deny'."
    );
  }
  validatePolicyRules(policy.rules);
  validatePolicyExpiresIn(policy.expiresIn);
  validatePolicyReasoningPrompt(policy.reasoningPrompt);
  return policy as ToolApprovalPolicy;
};

/**
 * The approved action is executed by the platform at resolution time, which a
 * `client` tool cannot be — it executes on the caller's machine. Enforced for
 * both binding forms (agents.md — Approval Policy, Restrictions).
 */
const assertPolicyToolTypeSupported = (args: {
  toolId: string | undefined;
  type: string | undefined;
}): void => {
  if ((args.type ?? 'http') === 'client') {
    throw new DomainError(
      'VALIDATION_FAILED',
      `approval_policy is not supported on client tool bindings${
        args.toolId ? ` ('${args.toolId}')` : ''
      } — the platform cannot execute the approved action at resolution time.`
    );
  }
};

const validateBindingApprovalPolicy = async (args: {
  binding: Record<string, unknown>;
  projectId: number;
}): Promise<void> => {
  const policy = args.binding.approvalPolicy;
  if (policy === undefined || policy === null) return;

  validateApprovalPolicyShape(policy);

  if (typeof args.binding.toolId === 'string') {
    // The policy needs the tool's type (client bindings are rejected), so a
    // policy-carrying reference must resolve — unlike a bare binding, which
    // keeps the historical lax behavior (unknown IDs are skipped at
    // generation time).
    const tool = await db.Tool.findOne({
      where: { publicId: args.binding.toolId, projectId: args.projectId },
    });
    if (!tool) {
      throw new DomainError(
        'TOOL_NOT_FOUND',
        `Tool '${args.binding.toolId}' not found in the project.`
      );
    }
    assertPolicyToolTypeSupported({
      toolId: args.binding.toolId,
      type: (tool as unknown as { type: string | null }).type ?? undefined,
    });
    return;
  }

  const inline = args.binding.tool as InlineToolDefinition;
  assertPolicyToolTypeSupported({ toolId: undefined, type: inline.type });
};

// An inline binding tool follows the same rules as the deprecated `tools`
// field entries: a plain object, an ephemeral-supported type, and a valid
// definition within the project.
const validateInlineBindingTool = async (args: {
  tool: unknown;
  projectId: number;
}): Promise<void> => {
  if (!isPlainObject(args.tool)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'A tool_bindings inline tool must be an object.'
    );
  }
  const definition = args.tool as InlineToolDefinition;
  assertEphemeralTypeSupported(definition);
  await validateToolDefinition({ definition, projectId: args.projectId });
};

// Validates a single binding entry — shape (exactly one of `tool_id`/`tool`),
// inline definition rules, and its `approval_policy` — and returns the entry
// with only its defined keys, ready to persist.
const validateBindingEntry = async (args: {
  entry: unknown;
  projectId: number;
}): Promise<AgentToolBinding> => {
  const { entry, projectId } = args;
  if (!isPlainObject(entry)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'Each tool_bindings entry must be an object.'
    );
  }

  const hasToolId = typeof entry.toolId === 'string' && entry.toolId !== '';
  const hasInline = entry.tool !== undefined && entry.tool !== null;
  if (hasToolId === hasInline) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'Each tool_bindings entry requires exactly one of tool_id or tool.'
    );
  }

  if (hasInline) {
    await validateInlineBindingTool({ tool: entry.tool, projectId });
  }

  await validateBindingApprovalPolicy({ binding: entry, projectId });

  const clean: AgentToolBinding = {};
  if (hasToolId) clean.toolId = entry.toolId as string;
  if (hasInline) clean.tool = entry.tool as InlineToolDefinition;
  if (entry.approvalPolicy !== undefined && entry.approvalPolicy !== null) {
    clean.approvalPolicy = entry.approvalPolicy as ToolApprovalPolicy;
  }
  return clean;
};

/**
 * Validates newly provided `tool_bindings` entries: entry shape (exactly one
 * of `tool_id` / `tool`), inline definitions (same rules as the deprecated
 * `tools` field), and each `approval_policy`. Returns the bindings with only
 * their defined keys, ready to persist.
 */
export const validateToolBindings = async (args: {
  projectId: number;
  bindings: AgentToolBinding[];
}): Promise<AgentToolBinding[]> => {
  if (!Array.isArray(args.bindings)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'tool_bindings must be an array of binding objects.'
    );
  }

  log(
    'validateToolBindings: projectId=%d bindings=%d',
    args.projectId,
    args.bindings.length
  );

  const sanitized: AgentToolBinding[] = [];
  for (const entry of args.bindings) {
    sanitized.push(
      await validateBindingEntry({ entry, projectId: args.projectId })
    );
  }
  return sanitized;
};

// ── Deprecated-shorthand updates ──────────────────────────────────────────

/**
 * Applies a deprecated `toolIds` / `tools` update on top of the current
 * bindings, preserving the shorthands' historical independence: `toolIds`
 * replaces only the reference bindings, `tools` replaces only the inline
 * bindings. Replaced entries are rewritten bare — any `approvalPolicy` they
 * carried is dropped (agents.md — Deprecated: tool_ids and tools).
 */
export const applyLegacyToolUpdates = (args: {
  current: AgentToolBinding[] | null;
  toolIds?: string[] | null;
  tools?: InlineToolDefinition[] | null;
}): AgentToolBinding[] | null => {
  const current = args.current ?? [];

  const refs =
    args.toolIds === undefined
      ? current.filter((binding) => {
          return binding.toolId !== undefined;
        })
      : (args.toolIds ?? []).map((toolId): AgentToolBinding => {
          return { toolId };
        });

  const inline =
    args.tools === undefined
      ? current.filter((binding) => {
          return binding.tool !== undefined;
        })
      : (args.tools ?? []).map((tool): AgentToolBinding => {
          return { tool };
        });

  const merged = [...refs, ...inline];
  return merged.length > 0 ? merged : null;
};

// ── Write-path resolution ─────────────────────────────────────────────────

/**
 * `tool_bindings` is canonical; `tool_ids`/`tools` are deprecated shorthands
 * for it. A request must pick one form (agents.md — Deprecated: tool_ids and
 * tools).
 */
export const assertBindingFormsExclusive = (args: {
  toolBindings?: AgentToolBinding[] | null;
  toolIds?: string[] | null;
  tools?: InlineToolDefinition[] | null;
}): void => {
  if (
    args.toolBindings !== undefined &&
    (args.toolIds !== undefined || args.tools !== undefined)
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'tool_bindings cannot be combined with the deprecated tool_ids/tools fields.'
    );
  }
};

/**
 * Normalizes a create request's binding input — either the canonical
 * `tool_bindings` or the deprecated shorthands — into validated canonical
 * bindings (the shorthands' inline definitions were always validated on
 * write, so both forms ride the same validation path).
 */
export const resolveBindingsForCreate = async (args: {
  projectId: number;
  toolBindings?: AgentToolBinding[] | null;
  toolIds?: string[] | null;
  tools?: InlineToolDefinition[] | null;
}): Promise<AgentToolBinding[] | null> => {
  assertBindingFormsExclusive(args);
  const provided =
    args.toolBindings ??
    bindingsFromLegacyFields({
      toolIds: args.toolIds ?? null,
      tools: args.tools ?? null,
    });
  if (!provided) return null;
  return validateToolBindings({
    projectId: args.projectId,
    bindings: provided,
  });
};

/**
 * Resolves an update request's binding change: `tool_bindings` replaces the
 * whole list; the deprecated shorthands keep their historical independence,
 * each replacing only its own subset (with any approval_policy on replaced
 * entries dropped — agents.md). Returns `undefined` when the request touches
 * no binding field.
 */
export const resolveBindingsForUpdate = async (args: {
  projectId: number;
  current: AgentToolBinding[] | null;
  toolBindings?: AgentToolBinding[] | null;
  toolIds?: string[] | null;
  tools?: InlineToolDefinition[] | null;
}): Promise<AgentToolBinding[] | null | undefined> => {
  assertBindingFormsExclusive(args);

  if (args.toolBindings !== undefined) {
    if (args.toolBindings === null) return null;
    return validateToolBindings({
      projectId: args.projectId,
      bindings: args.toolBindings,
    });
  }

  if (args.toolIds === undefined && args.tools === undefined) return undefined;

  if (args.tools) {
    // New inline definitions are validated exactly as the old `tools` update
    // path did; pre-existing entries are not re-validated.
    await validateToolBindings({
      projectId: args.projectId,
      bindings: args.tools.map((tool) => {
        return { tool };
      }),
    });
  }
  return applyLegacyToolUpdates({
    current: args.current,
    toolIds: args.toolIds,
    tools: args.tools,
  });
};

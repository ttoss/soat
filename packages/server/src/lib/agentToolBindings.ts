import createDebug from 'debug';

import { DomainError } from '../errors';
import {
  assertEphemeralTypeSupported,
  type InlineToolDefinition,
  validateToolDefinition,
} from './tools';

const log = createDebug('soat:agents');

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * One entry of an agent's canonical `tool_bindings` — a persisted-tool
 * reference (`toolId`) or an inline definition (`tool`), never both. Mirrors
 * the pipeline `steps[]` reference-or-inline pattern. Tool-call gating is
 * owned entirely by [Guardrails](../rest/openapi/v1/guardrails.yaml); a binding
 * carries no gate of its own.
 */
export type AgentToolBinding = {
  toolId?: string;
  tool?: InlineToolDefinition;
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

// Validates a single binding entry — shape (exactly one of `tool_id`/`tool`)
// and inline definition rules — and returns the entry with only its defined
// keys, ready to persist.
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

  const clean: AgentToolBinding = {};
  if (hasToolId) clean.toolId = entry.toolId as string;
  if (hasInline) clean.tool = entry.tool as InlineToolDefinition;
  return clean;
};

/**
 * Validates newly provided `tool_bindings` entries: entry shape (exactly one
 * of `tool_id` / `tool`) and inline definitions (same rules as the deprecated
 * `tools` field). Returns the bindings with only their defined keys, ready to
 * persist.
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
 * bindings (agents.md — Deprecated: tool_ids and tools).
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
 * each replacing only its own subset (agents.md). Returns `undefined` when the
 * request touches no binding field.
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

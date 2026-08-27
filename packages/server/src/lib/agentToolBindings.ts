import createDebug from 'debug';

import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';
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
};

// ── Read / derive ─────────────────────────────────────────────────────────

/**
 * Reads an agent row's tool bindings.
 *
 * This used to normalize the pre-`toolBindings` `toolIds` / `tools` columns on
 * every read. Those columns are gone, so there is a single place bindings come
 * from.
 */
export const readAgentToolBindings = (
  row: AgentToolColumns
): AgentToolBinding[] | null => {
  return Array.isArray(row.toolBindings)
    ? (row.toolBindings as AgentToolBinding[])
    : null;
};

/**
 * Splits bindings into the reference ids and inline definitions that
 * `resolveAgentTools` takes as two separate arguments. Internal plumbing only —
 * `tool_bindings` is the single attachment field on the wire.
 *
 * Ordering invariant: each side is emitted in binding order.
 */
export const splitToolBindings = (
  bindings: AgentToolBinding[] | null
): {
  toolIds: string[];
  tools: InlineToolDefinition[];
} => {
  if (!bindings) return { toolIds: [], tools: [] };

  return {
    toolIds: bindings.flatMap((binding) => {
      return binding.toolId ? [binding.toolId] : [];
    }),
    tools: bindings.flatMap((binding) => {
      return binding.tool ? [binding.tool] : [];
    }),
  };
};

// ── Validation ────────────────────────────────────────────────────────────

// An inline binding tool must be a plain object of an ephemeral-supported
// type, carrying a definition that is valid within the project.
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

/** The wire shape of an inline tool definition — snake_case, as documented in agents.yaml. */
type WireInlineToolDefinition = {
  type?: string;
  name: string;
  description?: string;
  parameters?: object;
  execute?: object;
  mcp?: object;
  actions?: string[];
  denied_actions?: string[];
  preset_parameters?: object;
  pipeline?: object;
  output_mapping?: object;
};

// The fields whose names differ between the wire and canonical shapes.
// Single-word fields are identical in both and copied separately below.
const INLINE_TOOL_FIELD_PAIRS: Array<
  [keyof InlineToolDefinition, keyof WireInlineToolDefinition]
> = [
  ['deniedActions', 'denied_actions'],
  ['presetParameters', 'preset_parameters'],
  ['outputMapping', 'output_mapping'],
];

const SAME_SPELLING_FIELDS = [
  'type',
  'description',
  'parameters',
  'execute',
  'mcp',
  'actions',
  'pipeline',
] as const;

/**
 * Converts one inline tool definition from its wire (snake_case) shape to the
 * canonical `InlineToolDefinition` (camelCase). Every consumer of a
 * `tool_bindings` entry's inline `tool` — `toolsCall.ts`'s deny-list/preset-
 * parameter handling, `agentToolResolver.ts` — reads the camelCase fields, so
 * storing the wire object verbatim silently drops `denied_actions`/
 * `preset_parameters`/`output_mapping` (a deny-list that never denies).
 */
const fromWireInlineTool = (value: unknown): InlineToolDefinition | unknown => {
  if (!isPlainObject(value)) return value;
  const wire = value as WireInlineToolDefinition;
  const tool: InlineToolDefinition = { name: wire.name };
  for (const field of SAME_SPELLING_FIELDS) {
    if (wire[field] !== undefined)
      (tool as Record<string, unknown>)[field] = wire[field];
  }
  for (const [camelKey, snakeKey] of INLINE_TOOL_FIELD_PAIRS) {
    if (wire[snakeKey] !== undefined) {
      (tool as Record<string, unknown>)[camelKey] = wire[snakeKey];
    }
  }
  return tool;
};

/** Reverses {@link fromWireInlineTool} for a response body. */
const toWireInlineTool = (
  tool: InlineToolDefinition
): WireInlineToolDefinition => {
  const wire: WireInlineToolDefinition = { name: tool.name };
  for (const field of SAME_SPELLING_FIELDS) {
    if (tool[field] !== undefined)
      (wire as Record<string, unknown>)[field] = tool[field];
  }
  for (const [camelKey, snakeKey] of INLINE_TOOL_FIELD_PAIRS) {
    if (tool[camelKey] !== undefined) {
      (wire as Record<string, unknown>)[snakeKey] = tool[camelKey];
    }
  }
  return wire;
};

/** Parses one wire `tool_bindings` entry (snake_case `tool_id`) into the canonical internal shape. */
const fromWireBindingEntry = (entry: unknown): unknown => {
  if (!isPlainObject(entry)) return entry;
  const wire = entry as { tool_id?: string; tool?: unknown };
  const converted: AgentToolBinding = {};
  if (wire.tool_id !== undefined) converted.toolId = wire.tool_id;
  if (wire.tool !== undefined) {
    converted.tool = fromWireInlineTool(wire.tool) as InlineToolDefinition;
  }
  return converted;
};

/** Parses a raw wire `tool_bindings` array into canonical (camelCase) bindings, ready for validation. */
export const parseWireToolBindings = (
  value: unknown
): AgentToolBinding[] | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value)) return value as never;
  return value.map(fromWireBindingEntry) as AgentToolBinding[];
};

/** The wire shape of one `tool_bindings` entry — snake_case, as documented in agents.yaml. */
export type WireAgentToolBinding = {
  tool_id?: string;
  tool?: WireInlineToolDefinition;
};

/** Serializes one canonical binding to its wire shape for a response. */
export const toWireToolBinding = (
  binding: AgentToolBinding
): WireAgentToolBinding => {
  const wire: WireAgentToolBinding = {};
  if (binding.toolId !== undefined) wire.tool_id = binding.toolId;
  if (binding.tool !== undefined) wire.tool = toWireInlineTool(binding.tool);
  return wire;
};

/**
 * Validates newly provided `tool_bindings` entries: entry shape (exactly one
 * of `tool_id` / `tool`) and each inline definition. Returns the bindings with
 * only their defined keys, ready to persist.
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

// ── Write-path resolution ─────────────────────────────────────────────────

/** Validates a create request's `tool_bindings`, or `null` when it declares none. */
export const resolveBindingsForCreate = async (args: {
  projectId: number;
  toolBindings?: AgentToolBinding[] | null;
}): Promise<AgentToolBinding[] | null> => {
  if (!args.toolBindings) return null;
  return validateToolBindings({
    projectId: args.projectId,
    bindings: args.toolBindings,
  });
};

/**
 * Resolves an update request's binding change: `tool_bindings` replaces the
 * whole list, and `null` clears it. Returns `undefined` when the request does
 * not touch the field.
 */
export const resolveBindingsForUpdate = async (args: {
  projectId: number;
  toolBindings?: AgentToolBinding[] | null;
}): Promise<AgentToolBinding[] | null | undefined> => {
  if (args.toolBindings === undefined) return undefined;
  if (args.toolBindings === null) return null;
  return validateToolBindings({
    projectId: args.projectId,
    bindings: args.toolBindings,
  });
};

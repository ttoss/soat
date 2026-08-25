import { DomainError } from 'src/errors';
import { validateMetadataBag } from 'src/lib/metadataBag';
import {
  parseOrchestrationEdges,
  parseOrchestrationNodes,
} from 'src/lib/orchestrationGraphWire';

/**
 * Request-body parsing for the orchestrations routes.
 *
 * The graph fields go through `orchestrationGraphWire`, which is the one place
 * the snake_case wire node is converted to the camelCase node the engine reads.
 * Everything else is read with its spec field name directly.
 */

export type RawCreateBody = {
  project_id?: string;
  name?: unknown;
  description?: unknown;
  nodes?: unknown;
  edges?: unknown;
  state_schema?: unknown;
  input_schema?: unknown;
  version_label?: unknown;
};

export type RawUpdateBody = {
  name?: unknown;
  description?: unknown;
  nodes?: unknown;
  edges?: unknown;
  state_schema?: unknown;
  input_schema?: unknown;
  version_label?: unknown;
};

/** The tag to attach to the version a write archives, when one was given. */
export const parseVersionLabel = (raw: unknown): string | undefined => {
  return typeof raw === 'string' ? raw : undefined;
};

export const validateCreateBody = (
  body: RawCreateBody
): { error: string } | { name: string; nodes: unknown[]; edges: unknown[] } => {
  if (!body.name || typeof body.name !== 'string') {
    return { error: 'name is required' };
  }
  if (!Array.isArray(body.nodes)) {
    return { error: 'nodes must be an array' };
  }
  if (!Array.isArray(body.edges)) {
    return { error: 'edges must be an array' };
  }
  return { name: body.name, nodes: body.nodes, edges: body.edges };
};

export const parseUpdateBody = (body: RawUpdateBody) => {
  return {
    name: typeof body.name === 'string' ? body.name : undefined,
    description:
      body.description !== undefined
        ? body.description === null
          ? null
          : String(body.description)
        : undefined,
    nodes: parseOrchestrationNodes(body.nodes) as never[] | undefined,
    edges: parseOrchestrationEdges(body.edges) as never[] | undefined,
    stateSchema:
      body.state_schema !== undefined
        ? (body.state_schema as object | null)
        : undefined,
    inputSchema:
      body.input_schema !== undefined
        ? (body.input_schema as object | null)
        : undefined,
    versionLabel: parseVersionLabel(body.version_label),
  };
};

export const parseRunInput = (
  raw: unknown
): Record<string, unknown> | undefined => {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
};

/**
 * The run's `tool_context` bag. Values are stringified rather than rejected —
 * the same leniency every other `tool_context` entry point has — but the keys
 * are left exactly as the caller wrote them, for `assertValidToolContextKeys`
 * in the lib to accept or reject (`.claude/rules/case-convention.md`: a bag's
 * keys are never rewritten).
 */
export const parseRunToolContext = (
  raw: unknown
): Record<string, string> | undefined => {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([key, value]) => {
      return [key, String(value)];
    })
  );
};

/**
 * The run's caller-owned `metadata` bag (#342). Unlike `tool_context`, values
 * are not stringified — the bag round-trips verbatim, so a nested object or a
 * number stays what the caller wrote. A non-object is rejected rather than
 * coerced, with the same message every other `metadata` entry point uses.
 */
export const parseRunMetadata = (
  raw: unknown
): Record<string, unknown> | undefined => {
  if (raw === undefined) return undefined;

  const error = validateMetadataBag(raw);
  if (error) {
    throw new DomainError('VALIDATION_FAILED', error);
  }

  return raw as Record<string, unknown>;
};

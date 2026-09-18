import {
  parseOrchestrationEdges,
  parseOrchestrationNodes,
} from 'src/lib/orchestrationGraphWire';

import { DomainError } from '../../errors';

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

/** The `orchestration_runs.idempotency_key` column's width. */
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export const parseRunInput = (
  raw: unknown
): Record<string, unknown> | undefined => {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
};

/**
 * The run's deduplication key. Refused rather than coerced: a caller whose key
 * arrived as a number wanted at-most-once and would silently get at-least-once.
 */
export const parseIdempotencyKey = (raw: unknown): string | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'idempotency_key must be a non-empty string.'
    );
  }
  if (raw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `idempotency_key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters.`
    );
  }
  return raw;
};

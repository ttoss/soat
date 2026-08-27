import createDebug from 'debug';

import {
  GENERATION_CONTENT_FIELDS,
  resolveAgentTraceContentMode,
  ZERO_RETENTION_PRINCIPAL,
} from './traceContentPolicy';

const log = createDebug('soat:generation-content');

/**
 * Removes every content column from a pending update when the agent runs in
 * zero-retention mode, and stamps the never-stored marker the first time.
 *
 * Mutates `updates` in place — the caller passes the object it is about to
 * write, so there is no second, unfiltered copy for a later edit to reach for.
 */
export const suppressContentWrites = async (args: {
  agentDbId: number;
  alreadyRedacted: boolean;
  updates: Record<string, unknown>;
}): Promise<void> => {
  // Not only an optimization: several lifecycle writes are fire-and-forget, and
  // a caller reading the row straight after is racing them. An extra query
  // widens that window to decide something these writes cannot change. Nothing
  // is lost — a zero-retention generation is already stamped at creation.
  const writesContent = GENERATION_CONTENT_FIELDS.some((field) => {
    return field in args.updates;
  });
  if (!writesContent) return;

  const mode = await resolveAgentTraceContentMode({
    agentDbId: args.agentDbId,
  });
  if (mode !== 'none') return;

  // Null rather than merely omitted, so a column written before the mode was
  // tightened is cleared by the next update rather than lingering.
  for (const field of GENERATION_CONTENT_FIELDS) {
    args.updates[field] = null;
  }

  // Stamped once. A row already marked keeps its original timestamp, matching
  // the idempotence a purge guarantees.
  if (args.alreadyRedacted) return;
  args.updates.contentRedactedAt = new Date();
  args.updates.contentRedactedByPrincipalType =
    ZERO_RETENTION_PRINCIPAL.principalType;
  args.updates.contentRedactedByPrincipalId =
    ZERO_RETENTION_PRINCIPAL.principalId;
};

/**
 * The content columns a generation create should write: the caller's metadata
 * for a storing agent, or nulls plus the never-stored marker in zero-retention
 * mode. Keeps the create path from having to know the field set.
 */
export const buildCreateContentColumns = async (args: {
  agentDbId: number;
  metadata?: Record<string, unknown> | null;
  inputMessages?: unknown[] | null;
}): Promise<Record<string, unknown>> => {
  const columns: Record<string, unknown> = {
    metadata: args.metadata ?? null,
    inputMessages: args.inputMessages ?? null,
  };
  await suppressContentWrites({
    agentDbId: args.agentDbId,
    alreadyRedacted: false,
    updates: columns,
  });
  log('buildCreateContentColumns: agentDbId=%d', args.agentDbId);
  return columns;
};

import createDebug from 'debug';

import { db } from '../db';

const log = createDebug('soat:trace-content-policy');

/**
 * Whether trace/generation content is persisted at all.
 *
 * - `full` — content is written and kept until purged, either on demand
 *   (`DELETE /traces/{id}/content`, #836) or by the retention sweep (#837).
 * - `none` — zero-retention: content is never written in the first place
 *   (#838). "We never stored it" is a stronger claim than "we deleted it", and
 *   it is the only mode where content cannot be missed by a sweep or survive in
 *   a backup.
 */
export const TRACE_CONTENT_MODES = ['full', 'none'] as const;

export type TraceContentMode = (typeof TRACE_CONTENT_MODES)[number];

const MODE_ERROR = `trace_content_mode must be one of: ${TRACE_CONTENT_MODES.join(
  ', '
)}.`;

const isTraceContentMode = (value: unknown): value is TraceContentMode => {
  return (
    typeof value === 'string' &&
    (TRACE_CONTENT_MODES as readonly string[]).includes(value)
  );
};

/**
 * Validates a project's `trace_content_mode`. Returns an error message, or
 * `null` when valid. Pure — shared by the REST handler and the formation
 * module so the rule is defined once (modules.md — Shared Business Rules).
 */
export const validateTraceContentMode = (value: unknown): string | null => {
  return isTraceContentMode(value) ? null : MODE_ERROR;
};

/**
 * Validates an agent's `trace_content_mode` against its project's.
 *
 * `null` inherits the project. Otherwise the agent may only **tighten**: it can
 * set `none` under a storing project, but it cannot set `full` under a
 * zero-retention project. The project is a floor, exactly as project-scope
 * `guardrailIds` is a floor for agent-scope ones — otherwise a project-wide
 * zero-retention mandate could be escaped simply by creating a new agent.
 */
export const validateAgentTraceContentMode = (args: {
  projectMode: string;
  agentMode: unknown;
}): string | null => {
  if (args.agentMode === null || args.agentMode === undefined) return null;

  const invalid = validateTraceContentMode(args.agentMode);
  if (invalid) return invalid;

  if (args.projectMode === 'none' && args.agentMode === 'full') {
    return "This project cannot store content (trace_content_mode 'none'); an agent may tighten to 'none' but not loosen to 'full'.";
  }

  return null;
};

/**
 * The effective mode for a generation: the stricter of the project's and the
 * agent's.
 *
 * Fails closed. An unrecognised stored value resolves to `none`, so a corrupt
 * or hand-edited column can never be read as permission to write content. The
 * `project=none, agent=full` combination is refused on write, but resolving it
 * to `none` here means a row that predates the guard is still handled safely.
 */
export const resolveTraceContentMode = (args: {
  projectMode: string;
  agentMode?: string | null;
}): TraceContentMode => {
  if (args.agentMode === 'none') return 'none';
  return args.projectMode === 'full' ? 'full' : 'none';
};

const RETENTION_ERROR =
  'trace_content_retention_days must be an integer >= 1, or null to disable retention.';

/**
 * Validates a project's `trace_content_retention_days`. `null` disables
 * retention; otherwise it must be a whole number of days ≥ 1.
 */
export const validateTraceContentRetentionDays = (
  value: unknown
): string | null => {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return RETENTION_ERROR;
  }
  return null;
};

/**
 * The generation columns that hold content rather than skeleton.
 *
 * `metadata` and `error` are caller/provider content, `extraction` is a summary
 * derived from that content, `pendingState` holds the full message history of a
 * paused run, and `inputMessages` holds the messages the turn was asked to
 * answer. Everything the billing and audit ledger reads — ids, timestamps,
 * status, stop reason, usage attribution — is deliberately absent.
 *
 * Defined here, once, because two features must agree on it exactly: the purge
 * path clears these columns (#836/#837) and zero-retention refuses to write
 * them (#838). A field added to one list and not the other would be a field
 * that a purge erases but zero-retention still persists — the drift this shared
 * definition makes unrepresentable.
 */
export const GENERATION_CONTENT_FIELDS = [
  'metadata',
  'error',
  'extraction',
  'pendingState',
  'inputMessages',
] as const;

/** The same set as a null-map, for a bulk `UPDATE`. */
export const PURGED_GENERATION_CONTENT = {
  metadata: null,
  error: null,
  extraction: null,
  pendingState: null,
  inputMessages: null,
} as const;

/** Trace columns that hold content. `fileId` drops the pointer to the steps
 * object, whose bytes are deleted after commit; `error` can carry a tool's
 * request/response bodies, so it is content and not skeleton. */
export const PURGED_TRACE_CONTENT = {
  fileId: null,
  error: null,
} as const;

/** Principal recorded on rows whose content was never written because the
 * agent or project runs in zero-retention mode. The skeleton is stamped exactly
 * as a purge stamps it — the principal id is what distinguishes "never stored"
 * from "stored, then erased". */
export const ZERO_RETENTION_PRINCIPAL = {
  principalType: 'system',
  principalId: 'zero_retention',
} as const;

/**
 * Cached because {@link resolveAgentTraceContentMode} sits on the generation
 * write path, which touches it several times per run. Kept short and mirrored
 * on the audit read-flag cache: writes invalidate the entry, and the TTL is the
 * backstop that converges other instances after a flip.
 */
const MODE_CACHE_TTL_MS = 30_000;

const modeCache = new Map<
  string,
  { mode: TraceContentMode; expiresAt: number }
>();

/**
 * Drops every cached mode for an agent. Called whenever the agent is written.
 *
 * The cache is keyed by whichever id the caller had (`db:<id>` on the
 * generation-update path, `pub:<projectId>:<publicId>` on the trace-write
 * path), so an invalidation must clear both spellings of the same agent.
 */
export const invalidateTraceContentModeCache = (args: {
  agentDbId?: number;
  projectDbId?: number;
  agentPublicId?: string;
}): void => {
  if (args.agentDbId !== undefined) modeCache.delete(`db:${args.agentDbId}`);
  if (args.agentPublicId !== undefined && args.projectDbId !== undefined) {
    modeCache.delete(`pub:${args.projectDbId}:${args.agentPublicId}`);
  }
};

/**
 * Drops every cached mode. Called when a project's mode changes — the flip
 * affects all of its agents, and the cache is keyed by agent, so there is no
 * cheaper key to invalidate.
 */
export const clearTraceContentModeCache = (): void => {
  modeCache.clear();
};

/** Built lazily: `db` is populated when the connection is established, which is
 * after this module is first required. */
const projectInclude = () => {
  return {
    attributes: ['id', 'traceContentMode', 'projectId'] as string[],
    include: [
      {
        model: db.Project,
        as: 'project',
        attributes: ['id', 'traceContentMode'],
      },
    ],
  };
};

/**
 * Resolves the effective mode from an already-loaded agent row, or `none` when
 * there is no row.
 *
 * Fails closed on a missing agent: the only callers are content-write
 * chokepoints, and writing content for an agent that cannot be found is the
 * worse of the two errors.
 */
const modeOf = (
  agent: {
    traceContentMode: string | null;
    project?: { traceContentMode: string };
  } | null,
  cacheKey: string
): TraceContentMode => {
  const mode =
    agent && agent.project
      ? resolveTraceContentMode({
          projectMode: agent.project.traceContentMode,
          agentMode: agent.traceContentMode,
        })
      : 'none';

  if (!agent) {
    log('modeOf: %s not found, failing closed to none', cacheKey);
  }

  modeCache.set(cacheKey, { mode, expiresAt: Date.now() + MODE_CACHE_TTL_MS });
  return mode;
};

const cachedMode = (cacheKey: string): TraceContentMode | undefined => {
  const cached = modeCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    modeCache.delete(cacheKey);
    return undefined;
  }
  return cached.mode;
};

/** Effective mode for an agent named by its **internal** id — the generation
 * update path, which reads the id off the generation row it already loaded. */
export const resolveAgentTraceContentMode = async (args: {
  agentDbId: number;
}): Promise<TraceContentMode> => {
  const key = `db:${args.agentDbId}`;
  const hit = cachedMode(key);
  if (hit) return hit;

  const agent = await db.Agent.findByPk(args.agentDbId, projectInclude());
  return modeOf(agent, key);
};

/** Effective mode for an agent named by its **public** id within a project —
 * the trace/generation write path, which is given the public id by its caller. */
export const resolveTraceContentModeForAgent = async (args: {
  projectDbId: number;
  agentPublicId: string;
}): Promise<TraceContentMode> => {
  const key = `pub:${args.projectDbId}:${args.agentPublicId}`;
  const hit = cachedMode(key);
  if (hit) return hit;

  const agent = await db.Agent.findOne({
    where: { publicId: args.agentPublicId, projectId: args.projectDbId },
    ...projectInclude(),
  });
  return modeOf(agent, key);
};

import type { SessionRow } from './sessionAccessor';
import type { UsageTotals } from './usageReceipt';

/**
 * The wire shape of a session.
 *
 * It lives in a leaf module because both `sessions.ts` and `sessionFork.ts`
 * return sessions, and a second transcription of the field list is exactly how
 * two read paths drift apart.
 */

const extractSessionIds = (session: SessionRow) => {
  return {
    agent_id: session.agent?.publicId ?? null,
    conversation_id: session.conversation?.publicId ?? null,
    actor_id: session.actor?.publicId ?? null,
    // Null on a session that was not forked, and also on a fork whose parent
    // has since been deleted (`ON DELETE SET NULL`) — the fork itself survives.
    forked_from_session_id: session.forkedFrom?.publicId ?? null,
  };
};

const extractSessionFlags = (session: SessionRow) => {
  return {
    auto_generate: session.autoGenerate ?? false,
  };
};

const extractSessionOptional = (session: SessionRow) => {
  return {
    tags: session.tags ?? undefined,
    tool_context: session.toolContext ?? null,
    generating_at: session.generatingAt ?? null,
    inactivity_ttl_seconds: session.inactivityTtlSeconds ?? 0,
    last_activity_at: session.lastActivityAt ?? null,
    message_delay_seconds: session.messageDelaySeconds ?? null,
    forked_from_position: session.forkedFromPosition ?? null,
    agent_version: session.agentVersion ?? null,
  };
};

/**
 * `usage` is what the session's generations cost, in the shape an orchestration
 * run already reports. Passed in rather than looked up here so it stays on the
 * single-session read: a listing would roll one up per row, and the formation
 * drift check reads sessions too and discards it.
 */
export const mapSession = (session: SessionRow, usage?: UsageTotals) => {
  return {
    id: session.publicId,
    ...extractSessionIds(session),
    status: session.status,
    name: session.name ?? null,
    ...extractSessionFlags(session),
    ...extractSessionOptional(session),
    ...(usage ? { usage } : {}),
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
};

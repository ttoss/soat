import type { AuthUser } from '../Context';
import { db } from '../db';
import { authUserOfWork } from '../middleware/auth';
import type { AgentAuthority } from './agentAuthority';
import { authorizationDenied, callerDenied } from './authorizationDenial';
import {
  agentHeldGrant,
  narrowAuthority,
  type WorkAuthority,
} from './workAuthority';

/**
 * The authority an agent turn acts under: under `run_as: agent`, the agent's
 * grant alone; under `run_as: caller`, the caller held to the agent's
 * `policy_ids` (no cap when it has none). Without an agent, the caller's own.
 */
export const turnAuthority = (args: {
  authority: WorkAuthority | null;
  agentAuthority?: AgentAuthority;
}): WorkAuthority | null => {
  const { authority, agentAuthority } = args;
  if (!authority || !agentAuthority) return authority;
  const grant = agentHeldGrant({
    agent: agentAuthority.agentId ?? '',
    policy: agentAuthority.policy,
  });
  if (agentAuthority.runAs === 'agent') {
    // The work's principal, chain and work id carry on; its grant and caps do not.
    return {
      ...authority,
      project: agentAuthority.projectPublicId,
      grant,
      caps: [],
    };
  }
  if (!agentAuthority.policy) return authority;
  return narrowAuthority({ authority, by: { grant, caps: [] } });
};

/**
 * The authority what the caller names in a turn (a document, a `tool_output`,
 * a `knowledge_config` override) is read under: the caller's, capped by the
 * agent's `policy_ids` only when the agent runs as the caller.
 */
export const callerNamedAuthority = (args: {
  authority: WorkAuthority | null;
  agentAuthority?: AgentAuthority;
}): WorkAuthority | null => {
  return args.agentAuthority?.runAs === 'agent'
    ? args.authority
    : turnAuthority(args);
};

/** The evaluator for `authority`; undefined when it holds none. */
export const authUserUnder = async (
  authority: WorkAuthority | null
): Promise<AuthUser | undefined> => {
  return authority ? authUserOfWork({ db, authority }) : undefined;
};

export type GateCheck = {
  projectPublicId: string;
  action: string;
  resource?: string;
  /** Any Allow wins, any Deny loses: a path-based SRN fallback. */
  resources?: string[];
  context?: Record<string, string>;
};

/**
 * The one check every agent tool call and content read crosses: each of
 * `checks` must be allowed under `authority`, else the denial names the set
 * that refused. No authority allows nothing.
 */
export const assertAllowedUnder = async (args: {
  authority: WorkAuthority | null;
  checks: GateCheck[];
}): Promise<void> => {
  const authUser = await authUserUnder(args.authority);
  for (const check of args.checks) {
    const resource = check.resource ?? check.resources?.[0] ?? null;
    if (!authUser) {
      throw authorizationDenied({
        principal: { type: 'caller', id: null },
        denied: [{ action: check.action, resource }],
      });
    }
    if (!(await authUser.isAllowed(check))) {
      throw callerDenied({ authUser, action: check.action, resource });
    }
  }
};

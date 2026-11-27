import type { AuthUser } from '../Context';
import { db } from '../db';
import { authUserOfWork, workCaller } from '../middleware/auth';
import { assertWorkAdmitted } from './admission';
import {
  type AgentAuthority,
  agentPolicyOf,
  projectCapOf,
} from './agentAuthority';
import { callerDenied } from './authorizationDenial';
import { principalFromAuthUser } from './principals';
import {
  agentHeldGrant,
  type AuthorityCap,
  captureAuthority,
  narrowAuthority,
  sameWorkAuthority,
  type WorkAuthority,
} from './workAuthority';

/** The owner project's `agent_policy_ids` over `agentAuthority`'s turn. */
const projectCaps = (agentAuthority: AgentAuthority): AuthorityCap[] => {
  const project =
    agentAuthority.runAs === 'agent'
      ? agentAuthority.capProject
      : projectCapOf(agentAuthority)?.by.id;
  return project ? [{ kind: 'project_agents', project }] : [];
};

/**
 * The authority an agent turn acts under, capped by its owner project's
 * `agent_policy_ids`: under `run_as: agent`, the agent's grant alone; under
 * `run_as: caller`, the caller held to the agent's `policy_ids` (no cap when
 * it has none). Without an agent, the caller's own.
 */
export const turnAuthority = (args: {
  authority: WorkAuthority | null;
  agentAuthority?: AgentAuthority;
}): WorkAuthority | null => {
  const { authority, agentAuthority } = args;
  if (!authority || !agentAuthority) return authority;
  const caps = projectCaps(agentAuthority);
  if (agentAuthority.runAs === 'agent') {
    // The work's principal, chain and work id carry on; its grant and caps do not.
    return {
      ...authority,
      project: agentAuthority.projectPublicId,
      grant: agentHeldGrant({
        agent: agentAuthority.agentId,
        policy: agentAuthority.grant,
      }),
      caps,
    };
  }
  const policy = agentPolicyOf(agentAuthority);
  return narrowAuthority({
    authority,
    by: {
      grant: policy
        ? agentHeldGrant({ agent: agentAuthority.agentId ?? '', policy })
        : authority.grant,
      caps,
    },
  });
};

/**
 * The authority what the caller names in a turn (a document, a `tool_output`,
 * a `knowledge_config` override) is read under: the caller's, capped by the
 * owner project's `agent_policy_ids`, and by the agent's `policy_ids` only
 * when the agent runs as the caller.
 */
export const callerNamedAuthority = (args: {
  authority: WorkAuthority | null;
  agentAuthority?: AgentAuthority;
}): WorkAuthority | null => {
  const { authority, agentAuthority } = args;
  if (agentAuthority?.runAs !== 'agent' || !authority) {
    return turnAuthority(args);
  }
  return narrowAuthority({
    authority,
    by: { grant: authority.grant, caps: projectCaps(agentAuthority) },
  });
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

const assertEach = async (args: {
  authUser: AuthUser;
  checks: GateCheck[];
}): Promise<void> => {
  for (const check of args.checks) {
    const resource = check.resource ?? check.resources?.[0] ?? null;
    if (!(await args.authUser.isAllowed(check))) {
      throw callerDenied({
        authUser: args.authUser,
        action: check.action,
        resource,
      });
    }
  }
};

/** `srn:<project>:<type>:<id>` → its type and id; a `*` id names none. */
const srnParts = (
  resource: string | null
): { resourceType: string | null; targetId: string | null } => {
  const [, , resourceType, id] = resource?.split(':') ?? [];
  return {
    resourceType: resourceType ?? null,
    targetId: id && id !== '*' ? id : null,
  };
};

/** Asks admission about each allowed check, as the work's own step. */
const admitChecks = async (args: {
  authUser: AuthUser;
  checks: GateCheck[];
}): Promise<void> => {
  for (const check of args.checks) {
    await assertWorkAdmitted({
      action: check.action,
      projectPublicId: check.projectPublicId,
      ...srnParts(check.resource ?? check.resources?.[0] ?? null),
      principal: principalFromAuthUser(args.authUser),
    });
  }
};

/**
 * The one check every agent tool call and content read crosses: each of
 * `checks` must be allowed under `authority`, else the denial names the set
 * that refused; work holding no authority is refused (`workCaller`). With
 * `caller`, the request whose authority `authority` is or narrows, its own
 * audited authorizer checks first, and `authority` only when it narrows the
 * caller.
 */
export const assertAllowedUnder = async (args: {
  authority: WorkAuthority | null;
  checks: GateCheck[];
  caller?: AuthUser;
}): Promise<void> => {
  const { caller } = args;
  if (caller) {
    await assertEach({ authUser: caller, checks: args.checks });
    const own = captureAuthority({ authUser: caller });
    if (sameWorkAuthority({ a: args.authority, b: own })) {
      return admitChecks({ authUser: caller, checks: args.checks });
    }
  }
  const authUser = await workCaller({
    db,
    authority: args.authority,
    work: `The call to ${args.checks
      .map((check) => {
        return check.action;
      })
      .join(', ')}`,
  });
  await assertEach({ authUser, checks: args.checks });
  await admitChecks({ authUser, checks: args.checks });
};

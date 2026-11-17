import type { AuthUser } from '../Context';
import { db } from '../db';
import { resolveAgentForGeneration } from './agentGenerationRecovery';
import { buildSrn } from './iam';
import { buildResourceTagContext } from './tags';
import { assertAllowedUnder, type GateCheck } from './turnAuthority';
import { type WorkAuthority, workAuthorityMissing } from './workAuthority';

type GenerationStart = {
  agentId: string;
  projectIds?: number[];
  runProjectId?: number;
  sessionId?: string;
};

const sessionStart = async (sessionId: string): Promise<GateCheck | null> => {
  const session = await db.Session.findOne({
    where: { publicId: sessionId },
    attributes: ['tags'],
    include: [{ model: db.Project, as: 'project', attributes: ['publicId'] }],
  });
  const projectPublicId = session?.project?.publicId as string | undefined;
  if (!session || !projectPublicId) return null;
  return {
    projectPublicId,
    action: 'agents:SendSessionMessage',
    resource: buildSrn({
      projectPublicId,
      resourceType: 'session',
      resourceId: sessionId,
    }),
    context: buildResourceTagContext({
      resourceType: 'session',
      tags: session.tags,
    }),
  };
};

const agentStart = async (args: GenerationStart): Promise<GateCheck | null> => {
  const agent = await resolveAgentForGeneration(args);
  if (!agent) return null;
  const projectPublicId = agent.project.publicId as string;
  return {
    projectPublicId,
    action: 'agents:CreateAgentGeneration',
    resource: buildSrn({
      projectPublicId,
      resourceType: 'agent',
      resourceId: args.agentId,
    }),
  };
};

/**
 * The start check every generation crosses before anything is recorded, under
 * the authority the work runs under: a session's turn as its route checks it
 * (`agents:SendSessionMessage` on the session), any other turn as
 * `agents:CreateAgentGeneration` on the agent in the project it runs in. What
 * does not resolve is left to the turn's own lookup, which answers its `404`.
 */
export const gateGenerationStart = async (
  args: GenerationStart & {
    authority: WorkAuthority | null;
    authUser?: AuthUser;
  }
): Promise<void> => {
  const check = args.sessionId
    ? await sessionStart(args.sessionId)
    : await agentStart(args);
  if (!check) return;
  if (!args.authority) {
    throw workAuthorityMissing({
      work: `The generation of agent '${args.agentId}'`,
    });
  }
  await assertAllowedUnder({
    authority: args.authority,
    caller: args.authUser,
    checks: [check],
  });
};

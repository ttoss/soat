import { db } from '../db';
import { emitResourceEvent } from './eventBus';
import { mergeTags } from './tags';

// Both functions are only ever called by the session-tags REST routes
// (sessionSubResources.ts), which resolve the session's existence via
// `checkSessionAccess` — and pass back that same session's own `agentId` —
// before calling in. The session is therefore guaranteed to exist here.

export const getSessionTags = async (args: {
  agentId: number;
  sessionId: string;
}) => {
  const session = await db.Session.findOne({
    where: { publicId: args.sessionId, agentId: args.agentId },
  });

  return session!.tags ?? {};
};

export const updateSessionTags = async (args: {
  agentId: number;
  sessionId: string;
  tags: Record<string, string>;
  merge?: boolean;
}) => {
  const session = (await db.Session.findOne({
    where: { publicId: args.sessionId, agentId: args.agentId },
  }))!;

  session.tags = mergeTags({
    current: session.tags,
    incoming: args.tags,
    merge: args.merge,
  });

  await session.save();

  emitResourceEvent({
    type: 'sessions.tags.updated',
    projectId: session.projectId,
    resourceType: 'session',
    resourceId: session.publicId,
    data: { tags: session.tags },
  });

  return session.tags;
};

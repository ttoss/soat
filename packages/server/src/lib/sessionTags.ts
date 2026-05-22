import { DomainError } from '../errors';
import { db } from '../db';
import { emitEvent, resolveProjectPublicId } from './eventBus';

export const getSessionTags = async (args: {
  agentId: number;
  sessionId: string;
}) => {
  const session = await db.Session.findOne({
    where: { publicId: args.sessionId, agentId: args.agentId },
  });

  if (!session) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Session not found');
  }

  return session.tags ?? {};
};

export const updateSessionTags = async (args: {
  agentId: number;
  sessionId: string;
  tags: Record<string, string>;
  merge?: boolean;
}) => {
  const session = await db.Session.findOne({
    where: { publicId: args.sessionId, agentId: args.agentId },
  });

  if (!session) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Session not found');
  }

  if (args.merge) {
    session.tags = { ...(session.tags ?? {}), ...args.tags };
  } else {
    session.tags = args.tags;
  }

  await session.save();

  resolveProjectPublicId({ projectId: session.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'sessions.tags.updated',
        projectId: session.projectId,
        projectPublicId,
        resourceType: 'session',
        resourceId: session.publicId,
        data: { tags: session.tags },
        timestamp: new Date().toISOString(),
      });
    }
  );

  return session.tags;
};

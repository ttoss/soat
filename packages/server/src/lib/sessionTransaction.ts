import { db } from '../db';

export const createSessionTransaction = async (args: {
  projectId: number;
  agentId: number;
  agentName: string;
  name?: string | null;
  existingUserActorId?: number | null;
  autoGenerate?: boolean;
  toolContext?: Record<string, string> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction: any;
}): Promise<InstanceType<(typeof db)['Session']>> => {
  let userActorId = args.existingUserActorId;
  if (!userActorId) {
    const userActor = await db.Actor.create(
      {
        projectId: args.projectId,
        name: 'User',
        type: 'user',
      },
      { transaction: args.transaction }
    );
    userActorId = userActor.id;
  }

  const agentActor = await db.Actor.create(
    {
      projectId: args.projectId,
      name: args.agentName || 'Agent',
      type: 'agent',
      agentId: args.agentId,
    },
    { transaction: args.transaction }
  );

  const conversation = await db.Conversation.create(
    {
      projectId: args.projectId,
      name: args.name ?? null,
      status: 'open',
    },
    { transaction: args.transaction }
  );

  return db.Session.create(
    {
      projectId: args.projectId,
      agentId: args.agentId,
      conversationId: conversation.id,
      agentActorId: agentActor.id,
      userActorId,
      status: 'open',
      name: args.name ?? null,
      autoGenerate: args.autoGenerate ?? false,
      toolContext: args.toolContext ?? null,
    },
    { transaction: args.transaction }
  );
};

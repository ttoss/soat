import { db } from '../db';

export const createSessionTransaction = async (args: {
  projectId: number;
  agentId: number;
  name?: string | null;
  existingActorId?: number | null;
  autoGenerate?: boolean;
  toolContext?: Record<string, string> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction: any;
}): Promise<InstanceType<(typeof db)['Session']>> => {
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
      actorId: args.existingActorId ?? null,
      status: 'open',
      name: args.name ?? null,
      autoGenerate: args.autoGenerate ?? false,
      toolContext: args.toolContext ?? null,
    },
    { transaction: args.transaction }
  );
};

import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { lockForTransaction } from './advisoryLocks';
import { type Transaction } from './dbTransaction';
import { isUniqueViolationOf } from './uniqueViolation';

const log = createDebug('soat:conversationMessages');

const resolveMessagePosition = async (args: {
  conversationId: number;
  position?: number;
  transaction: Transaction;
}): Promise<number> => {
  if (args.position === undefined) {
    const maxMessage = await db.ConversationMessage.findOne({
      where: { conversationId: args.conversationId },
      order: [['position', 'DESC']],
      transaction: args.transaction,
    });
    return maxMessage ? maxMessage.position + 1 : 0;
  }

  const collision = await db.ConversationMessage.findOne({
    where: { conversationId: args.conversationId, position: args.position },
    transaction: args.transaction,
  });
  if (collision) {
    const toShift = await db.ConversationMessage.findAll({
      where: { conversationId: args.conversationId },
      order: [['position', 'DESC']],
      transaction: args.transaction,
    });
    for (const m of toShift) {
      if (m.position >= args.position) {
        await m.update(
          { position: m.position + 1 },
          { transaction: args.transaction }
        );
      }
    }
  }

  return args.position;
};

const POSITION_INDEX = 'conversation_messages_conversation_id_position_unique';

/**
 * The one writer of a conversation's message rows. Writes to one conversation
 * hold its lock while they resolve and take a `position`, so concurrent writes
 * queue rather than collide on the unique index.
 */
export const insertMessage = async (args: {
  conversationId: number;
  documentId: number;
  role: string;
  actorId?: number | null;
  agentId?: number | null;
  position?: number;
  metadata?: Record<string, unknown>;
  responseMessages?: unknown[];
  idempotencyKey: string | null;
  idempotencyDigest?: string | null;
}): Promise<InstanceType<(typeof db)['ConversationMessage']>> => {
  log(
    'insertMessage: conversationId=%d position=%s',
    args.conversationId,
    args.position
  );
  try {
    return await db.sequelize.transaction(async (t) => {
      await lockForTransaction({
        sequelize: db.sequelize,
        transaction: t,
        namespace: 'conversationWrites',
        id: args.conversationId,
      });

      const position = await resolveMessagePosition({
        conversationId: args.conversationId,
        position: args.position,
        transaction: t,
      });

      return db.ConversationMessage.create(
        {
          conversationId: args.conversationId,
          documentId: args.documentId,
          role: args.role,
          actorId: args.actorId ?? null,
          agentId: args.agentId ?? null,
          position,
          metadata: args.metadata ?? null,
          responseMessages: args.responseMessages ?? null,
          idempotencyKey: args.idempotencyKey,
          idempotencyDigest: args.idempotencyKey
            ? (args.idempotencyDigest ?? null)
            : null,
        },
        { transaction: t }
      );
    });
  } catch (error) {
    if (!isUniqueViolationOf({ error, index: POSITION_INDEX })) throw error;
    log(
      'insertMessage: conversationId=%d position taken outside the lock',
      args.conversationId
    );
    throw new DomainError(
      'CONVERSATION_POSITION_CONFLICT',
      'Another write took this message position at the same time. Nothing was written; retry the write.'
    );
  }
};

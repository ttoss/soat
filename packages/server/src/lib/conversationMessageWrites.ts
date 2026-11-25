import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { lockForTransaction } from './advisoryLocks';
import type { Citation } from './citationVerification';
import { type Transaction } from './dbTransaction';
import {
  provenanceColumns,
  type ProvenanceCounts,
} from './generationProvenance';
import { isUniqueViolationOf } from './uniqueViolation';
import type { PublicMessages, VendorOptions } from './vendorOptions';

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
 * What a message row carries beside who wrote it and where: the one list a
 * fork copies and an insert writes, so a new column reaches both.
 */
type MessageContent = {
  metadata?: Record<string, unknown> | null;
  fileIds?: string[] | null;
  responseMessages?: unknown[] | null;
  vendorOptions?: unknown[] | null;
  citations?: unknown[] | null;
};

type InsertMessageArgs = {
  conversationId: number;
  documentId: number;
  role: string;
  actorId?: number | null;
  agentId?: number | null;
  position?: number;
  metadata?: Record<string, unknown>;
  fileIds?: string[];
  responseMessages?: PublicMessages;
  vendorOptions?: VendorOptions;
  /** The producing turn's verified citations; `[]` when it cited none. */
  citations?: Citation[];
  idempotencyKey: string | null;
  idempotencyDigest?: string | null;
  /** What the message's content feeds a turn it is sent to. */
  provenance: ProvenanceCounts;
};

// Absent and empty optional bags are both stored as null; `citations` keeps
// `[]`, a turn that cited and had none verified.
export const contentColumns = (args: MessageContent) => {
  return {
    metadata: args.metadata ?? null,
    fileIds: args.fileIds?.length ? args.fileIds : null,
    responseMessages: args.responseMessages ?? null,
    vendorOptions: args.vendorOptions?.length ? args.vendorOptions : null,
    citations: args.citations ?? null,
  };
};

const messageColumns = (args: InsertMessageArgs) => {
  return {
    conversationId: args.conversationId,
    documentId: args.documentId,
    role: args.role,
    actorId: args.actorId ?? null,
    agentId: args.agentId ?? null,
    ...contentColumns(args),
    ...provenanceColumns(args.provenance),
    idempotencyKey: args.idempotencyKey,
    idempotencyDigest: args.idempotencyKey
      ? (args.idempotencyDigest ?? null)
      : null,
  };
};

/**
 * The one writer of a conversation's message rows. Writes to one conversation
 * hold its lock while they resolve and take a `position`, so concurrent writes
 * queue rather than collide on the unique index.
 */
export const insertMessage = async (
  args: InsertMessageArgs
): Promise<InstanceType<(typeof db)['ConversationMessage']>> => {
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
        { ...messageColumns(args), position },
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
      'Another write took this message position at the same time; nothing was written.'
    );
  }
};

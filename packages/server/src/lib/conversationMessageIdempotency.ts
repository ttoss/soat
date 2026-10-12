import createDebug from 'debug';

import { db } from '../db';
import { claimIdempotencyKey, idempotencyKeyReused } from './idempotencyClaim';

const log = createDebug('soat:conversationMessages');

type ConversationMessageRow = InstanceType<(typeof db)['ConversationMessage']>;

const findClaimedMessage = async <Replayed>(args: {
  conversationId: number;
  idempotencyKey: string;
  idempotencyDigest: string | null;
  toReplay: (message: ConversationMessageRow) => Promise<Replayed>;
}): Promise<Replayed | null> => {
  const existing = await db.ConversationMessage.findOne({
    where: {
      conversationId: args.conversationId,
      idempotencyKey: args.idempotencyKey,
    },
    include: [
      {
        model: db.Document,
        as: 'document',
        include: [{ model: db.File, as: 'file' }],
      },
      { model: db.Actor, as: 'actor' },
      { model: db.Agent, as: 'agent' },
    ],
  });
  if (!existing) return null;
  // A row written before digests were recorded carries none and is replayed.
  if (
    existing.idempotencyDigest &&
    args.idempotencyDigest &&
    existing.idempotencyDigest !== args.idempotencyDigest
  ) {
    log(
      'claimMessageKey: key=%s reused with a different request',
      args.idempotencyKey
    );
    throw idempotencyKeyReused({
      idempotencyKey: args.idempotencyKey,
      claimedBy: 'message',
    });
  }
  return args.toReplay(existing);
};

/**
 * Runs `create` at most once per key in the conversation. The unique index
 * settles a race between two requests carrying one key; the loser replays.
 */
export const claimMessageKey = async <Created, Replayed>(args: {
  conversationId: number;
  idempotencyKey?: string | null;
  idempotencyDigest?: string | null;
  toReplay: (message: ConversationMessageRow) => Promise<Replayed>;
  create: () => Promise<Created>;
}): Promise<Created | Replayed> => {
  const key = args.idempotencyKey;
  if (!key) return args.create();
  const claimed = await claimIdempotencyKey({
    replay: () => {
      return findClaimedMessage({
        conversationId: args.conversationId,
        idempotencyKey: key,
        idempotencyDigest: args.idempotencyDigest ?? null,
        toReplay: args.toReplay,
      });
    },
    create: args.create,
  });
  return 'created' in claimed ? claimed.created : claimed.replayed;
};

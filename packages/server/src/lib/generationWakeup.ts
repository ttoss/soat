/**
 * Wakes a process following a generation when another process appends to its
 * progress rows: `pg_notify` in the append's transaction, so the wake-up is
 * delivered only once the row is visible, and one `LISTEN` connection per
 * process, opened by its first subscriber. Followers poll as well, so a lost
 * notification or a dropped connection costs latency, never a row.
 */
import createDebug from 'debug';
import { Client } from 'pg';

import { db } from '../db';
import type { Transaction } from './dbTransaction';
import { loggableError } from './loggableError';

const log = createDebug('soat:generation-wakeup');

const CHANNEL = 'soat_generation_progress';

/** Announces a new row of `generationDbId`, delivered when `transaction` commits. */
export const notifyGenerationProgress = async (args: {
  generationDbId: number;
  transaction: Transaction;
}): Promise<void> => {
  await db.sequelize.query('SELECT pg_notify(:channel, :payload)', {
    replacements: { channel: CHANNEL, payload: String(args.generationDbId) },
    transaction: args.transaction,
  });
};

type Wake = () => void;

const subscribers = new Map<number, Set<Wake>>();

let listener: Promise<Client | null> | null = null;

const wakeAll = (generationDbId: number) => {
  for (const wake of subscribers.get(generationDbId) ?? []) wake();
};

const dropListener = (client: Client) => {
  log('listener: dropped');
  listener = null;
  client.removeAllListeners();
  void client.end().catch(() => {});
};

const openListener = async (): Promise<Client | null> => {
  const { host, port, database, username, password } = db.sequelize.config;
  const client = new Client({
    host,
    port: Number(port),
    database,
    user: username,
    password: password ?? undefined,
  });
  client.on('notification', (message) => {
    const generationDbId = Number(message.payload);
    if (Number.isInteger(generationDbId)) wakeAll(generationDbId);
  });
  client.on('error', (error) => {
    log('listener: error %o', loggableError(error));
    dropListener(client);
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    log('listener: listening');
    return client;
  } catch (error) {
    log('listener: could not listen, polling only %o', loggableError(error));
    dropListener(client);
    return null;
  }
};

/**
 * Calls `wake` whenever a row of `generationDbId` commits, in any process.
 * Returns the unsubscribe; the connection outlives its subscribers until
 * {@link closeGenerationWakeup}.
 */
export const subscribeGenerationProgress = (args: {
  generationDbId: number;
  wake: Wake;
}): (() => void) => {
  const { generationDbId, wake } = args;
  const set = subscribers.get(generationDbId) ?? new Set<Wake>();
  set.add(wake);
  subscribers.set(generationDbId, set);
  listener ??= openListener();
  return () => {
    set.delete(wake);
    if (set.size === 0) subscribers.delete(generationDbId);
  };
};

/** Closes this process's `LISTEN` connection (shutdown, test teardown). */
export const closeGenerationWakeup = async (): Promise<void> => {
  const pending = listener;
  listener = null;
  const client = await pending;
  if (!client) return;
  client.removeAllListeners();
  await client.end().catch(() => {});
};

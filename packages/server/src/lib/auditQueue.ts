import createDebug from 'debug';

import * as auditLog from './auditLog';

const log = createDebug('soat:audit');

type AuditWriteArgs = Parameters<typeof auditLog.writeAuditEntry>[0];

/**
 * Upper bound on entries buffered in memory. Auditing must never apply
 * backpressure to live traffic, so when the queue is full new entries are
 * dropped and counted (a metric, not an exception) rather than awaited.
 */
const MAX_QUEUE_SIZE = Number(process.env.AUDIT_QUEUE_MAX_SIZE) || 1000;

let queue: AuditWriteArgs[] = [];
let draining = false;
let drainPromise: Promise<void> = Promise.resolve();
let droppedCount = 0;

const drain = async (): Promise<void> => {
  while (queue.length > 0) {
    const job = queue.shift()!;
    // Fire-and-forget durability: a write failure (e.g. the DB is down) is
    // logged and swallowed so a single bad entry never stalls the queue and,
    // crucially, never surfaces on the request the entry describes.
    try {
      await auditLog.writeAuditEntry(job);
    } catch (error) {
      log('drain: write failed %o', error);
    }
  }
};

/**
 * Enqueues an audit entry for asynchronous, fire-and-forget persistence. Returns
 * immediately; the write happens off the request path. On overflow the entry is
 * dropped and {@link getDroppedAuditCount} is incremented.
 */
export const enqueueAuditWrite = (args: AuditWriteArgs): void => {
  if (queue.length >= MAX_QUEUE_SIZE) {
    droppedCount += 1;
    log('enqueueAuditWrite: queue full, dropped=%d', droppedCount);
    return;
  }

  queue.push(args);

  if (!draining) {
    draining = true;
    drainPromise = drain().finally(() => {
      draining = false;
    });
  }
};

/** Total entries dropped due to queue overflow since process start. */
export const getDroppedAuditCount = (): number => {
  return droppedCount;
};

/**
 * Resolves once the queue has drained. Test-only helper so a test can await the
 * asynchronous write it triggered before asserting on the stored entry.
 */
export const flushAuditQueue = async (): Promise<void> => {
  await drainPromise;
  if (queue.length > 0) {
    await drainPromise;
  }
};

/** Test-only: clears buffered entries and the dropped counter. */
export const resetAuditQueue = (): void => {
  queue = [];
  droppedCount = 0;
};

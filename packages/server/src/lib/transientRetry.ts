import createDebug from 'debug';

const log = createDebug('soat:transientRetry');

/** Attempts in total, not retries after the first. */
const DEFAULT_ATTEMPTS = 3;

/** Doubles per attempt, so three attempts span ~150ms of real time. */
const DEFAULT_BASE_DELAY_MS = 50;

const sleep = (ms: number) => {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
};

/**
 * Runs a database operation again when it rejects, and rethrows the last error
 * once the attempts are spent.
 *
 * For the writes that happen **after** their domain transaction has committed —
 * emitting an event, matching subscriptions, inserting the delivery row. The
 * response is already written, so a rejection there is not an error anyone can
 * be told about, only work that silently does not happen.
 *
 * Deliberately small and in-process. Retries that must survive a restart belong
 * in a row with its own due time — the webhook outbox and the orchestration
 * queue already are that, and this is only the step that gets an event into one.
 */
export const retryTransient = async <T>(args: {
  operation: () => Promise<T>;
  attempts?: number;
  baseDelayMs?: number;
  /** Names the operation in the retry log line. */
  label: string;
}): Promise<T> => {
  const attempts = args.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = args.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await args.operation();
    } catch (error) {
      lastError = error;
      log('%s: attempt %d/%d failed %o', args.label, attempt, attempts, error);
      if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError;
};

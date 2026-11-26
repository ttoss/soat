import { authenticatedTestClient } from '../testClient';

/** Long enough for queued work on a loaded runner; a settled read returns at once. */
const BUDGET_MS = 10_000;
const INTERVAL_MS = 25;
/** How long a fire-and-forget path is watched for a write it must not make. */
const WINDOW_MS = 500;
const SHOWN_CHARS = 2_000;

const sleep = () => {
  return new Promise((resolve) => {
    setTimeout(resolve, INTERVAL_MS);
  });
};

const shown = (value: unknown): string => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}…` : text;
};

/**
 * Reads until `pick` finds a value in what was read, within one budget.
 * Exhaustion throws with the last read, so a failure names the state the work
 * stopped in, not only that it stopped.
 */
export const pollFor = async <O, T>(args: {
  read: () => Promise<O> | O;
  pick: (observation: O) => T | undefined;
}): Promise<T> => {
  const startedAt = Date.now();
  for (;;) {
    const observation = await args.read();
    const picked = args.pick(observation);
    if (picked !== undefined) return picked;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= BUDGET_MS) {
      throw new Error(
        `poll never settled after ${elapsed} ms; last read: ${shown(observation)}`
      );
    }
    await sleep();
  }
};

/** Reads until `done` holds over the value read; see `pollFor`. */
export const pollUntil = async <T>(args: {
  read: () => Promise<T> | T;
  done: (value: T) => boolean;
}): Promise<T> => {
  const settled = await pollFor({
    read: args.read,
    pick: (value) => {
      return args.done(value) ? { value } : undefined;
    },
  });
  return settled.value;
};

/** GETs `path` until it answers `200` and `predicate` holds over the selected value. */
export const pollGet = async <T>(args: {
  token: string;
  path: string;
  select: (body: Record<string, unknown>) => T;
  predicate: (value: T) => boolean;
}): Promise<T> => {
  const settled = await pollFor({
    read: async () => {
      const res = await authenticatedTestClient(args.token).get(args.path);
      return { path: args.path, status: res.status, body: res.body };
    },
    pick: (res) => {
      if (res.status !== 200) return undefined;
      const value = args.select(res.body);
      return args.predicate(value) ? { value } : undefined;
    },
  });
  return settled.value;
};

/**
 * Runs `check` over fresh reads for a whole window: the assertion that a
 * fire-and-forget path leaves a state alone, which no completion signals.
 */
export const holdsThroughout = async <T>(args: {
  read: () => Promise<T> | T;
  check: (value: T) => void;
}): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < WINDOW_MS) {
    args.check(await args.read());
    await sleep();
  }
};

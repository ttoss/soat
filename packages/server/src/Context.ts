import type { DB } from './db';

export type Context = {
  db: DB;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} & Record<string, any>;

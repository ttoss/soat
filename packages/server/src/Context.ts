import type { DB } from './db';

export type AuthUser = {
  id: number;
  publicId: string;
  username: string;
  role: 'admin' | 'user';
  isAllowed: (projectPublicId: string, action: string) => Promise<boolean>;
};

export type Context = {
  db: DB;
  authUser?: AuthUser;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} & Record<string, any>;

import { createHash } from 'node:crypto';

import { Op } from '@ttoss/postgresdb';
import bcrypt from 'bcryptjs';
import createDebug from 'debug';

import { db } from '../db';

const log = createDebug('soat:apiKeyVerifier');

/** The `User` columns an authenticated request reads. */
export const AUTH_USER_ATTRIBUTES = [
  'id',
  'publicId',
  'username',
  'role',
  'policyIds',
  'createdAt',
  'updatedAt',
];

type ApiKeyRow = InstanceType<(typeof db)['ApiKey']>;
type UserRow = InstanceType<(typeof db)['User']>;

/**
 * Hex SHA-256 of a raw key. A plain fast hash is sound because a key is
 * `sk_` + 32 random bytes (`generateSecretValue`): no hash speed makes 256
 * bits guessable, so a slow hash would buy nothing but CPU on every request.
 */
export const hashApiKey = (args: { rawKey: string }): string => {
  return createHash('sha256').update(args.rawKey).digest('hex');
};

const withUser = () => {
  return { include: [{ model: db.User, attributes: AUTH_USER_ATTRIBUTES }] };
};

/**
 * A row with no SHA-256 yet: found by prefix and checked with bcrypt, then
 * given its SHA-256 so every later request takes the indexed lookup.
 */
const verifyByBcrypt = async (args: {
  rawKey: string;
  keyHashSha256: string;
}): Promise<ApiKeyRow | null> => {
  const candidates = await db.ApiKey.findAll({
    where: {
      keyPrefix: args.rawKey.substring(0, 8),
      keyHash: { [Op.ne]: null },
      keyHashSha256: null,
    },
    ...withUser(),
  });

  for (const row of candidates) {
    // `keyHash` is non-null: the `where` above selects only rows carrying one.
    if (await bcrypt.compare(args.rawKey, row.keyHash as string)) {
      await row.update({ keyHashSha256: args.keyHashSha256 });
      log('verifyByBcrypt: wrote SHA-256 for apiKey=%s', row.publicId);
      return row;
    }
  }
  return null;
};

/**
 * The one check of a raw `sk_` bearer against the stored keys, for REST and the
 * MCP gate alike. Null when the token is not a live key; callers route only
 * `sk_` bearers here.
 */
export const verifyApiKey = async (args: {
  rawKey: string;
}): Promise<{ apiKey: ApiKeyRow; user: UserRow } | null> => {
  const keyHashSha256 = hashApiKey({ rawKey: args.rawKey });
  const apiKey =
    (await db.ApiKey.findOne({ where: { keyHashSha256 }, ...withUser() })) ??
    (await verifyByBcrypt({ rawKey: args.rawKey, keyHashSha256 }));

  if (!apiKey) {
    log('verifyApiKey: no live key');
    return null;
  }
  log('verifyApiKey: apiKey=%s', apiKey.publicId);
  return { apiKey, user: apiKey.user };
};

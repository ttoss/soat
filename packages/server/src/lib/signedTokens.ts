import crypto from 'node:crypto';

import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';

const requireJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set');
  }
  return secret;
};

const JWT_SECRET = requireJwtSecret();

/**
 * Every kind of JWT the server signs. All share one secret, so a token is told
 * apart by its `typ` claim alone, never by which other claims it carries.
 */
export const TOKEN_TYPES = [
  'login',
  'oauth',
  'iam',
  'file-download',
  'ingestion-callback',
] as const;

export type TokenType = (typeof TOKEN_TYPES)[number];

/** The kinds a request may present as `Authorization: Bearer`, on REST and `/mcp`. */
export const BEARER_TOKEN_TYPES = [
  'login',
  'oauth',
  'iam',
] as const satisfies readonly TokenType[];

export type BearerTokenType = (typeof BEARER_TOKEN_TYPES)[number];

export type VerifiedToken<T extends TokenType> = JwtPayload & { typ: T };

export type TokenTtl = NonNullable<SignOptions['expiresIn']>;

/** `typ` is written last, so no claim can overwrite it. */
export const signToken = (args: {
  typ: TokenType;
  claims: Record<string, unknown>;
  expiresIn: TokenTtl;
}): string => {
  return jwt.sign({ ...args.claims, typ: args.typ }, JWT_SECRET, {
    expiresIn: args.expiresIn,
  });
};

const isAccepted = <T extends TokenType>(
  accept: readonly T[],
  typ: unknown
): typ is T => {
  return accept.some((kind) => {
    return kind === typ;
  });
};

/** The verified claims, or null for a token that is invalid, expired or of another kind. */
export const verifyToken = <T extends TokenType>(args: {
  token: string;
  accept: readonly T[];
}): VerifiedToken<T> | null => {
  try {
    const payload = jwt.verify(args.token, JWT_SECRET);
    if (typeof payload === 'string' || typeof payload.exp !== 'number') {
      return null;
    }
    const { typ } = payload;
    if (!isAccepted(args.accept, typ)) return null;
    return { ...payload, typ };
  } catch {
    return null;
  }
};

/** A 32-byte key derived from the server's secret, distinct per `info` label. */
export const deriveSecretKey = (args: { info: string }): Buffer => {
  return Buffer.from(
    crypto.hkdfSync('sha256', JWT_SECRET, Buffer.alloc(0), args.info, 32)
  );
};

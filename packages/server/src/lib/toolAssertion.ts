import crypto from 'node:crypto';

import createDebug from 'debug';

import { soatHeader } from './headerPrefix';
import { ISSUER } from './serverIssuer';
import { RESERVED_TOOL_CONTEXT_KEYS } from './toolContext';

const log = createDebug('soat:toolAssertion');

/**
 * Tool assertions — a short-lived EdDSA JWT on every outbound tool request,
 * naming the tool and project that sent it. Asymmetric so any receiver can
 * verify against the published JWKS without holding a secret that would also
 * let it forge one.
 */

/** Long enough for one request to arrive, short enough that a copy is stale. */
export const TOOL_ASSERTION_TTL_SECONDS = 60;

type PublishedKey = {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  alg: 'EdDSA';
  use: 'sig';
};

type SigningKey = { privateKey: crypto.KeyObject; published: PublishedKey };

let cached: { pem: string; key: SigningKey } | undefined;

/** RFC 7638: members in lexicographic order, no whitespace. */
const thumbprint = (x: string): string => {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x }))
    .digest('base64url');
};

/**
 * The deployment's signing key, or `null` when it configures none. Read per
 * call, like the context header prefix, so the value set is the value used.
 * `\n` escapes are accepted because a PEM in an env var usually arrives so.
 */
const signingKey = (): SigningKey | null => {
  const configured = process.env.TOOL_ASSERTION_PRIVATE_KEY;
  if (!configured) return null;
  if (cached?.pem === configured) return cached.key;

  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(configured.replace(/\\n/g, '\n'));
  } catch {
    throw new Error('TOOL_ASSERTION_PRIVATE_KEY is not a PEM private key.');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `TOOL_ASSERTION_PRIVATE_KEY must be an Ed25519 key; got ${privateKey.asymmetricKeyType ?? 'an unknown type'}.`
    );
  }
  const { x } = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof x !== 'string') {
    throw new Error(
      'TOOL_ASSERTION_PRIVATE_KEY has no public half to publish.'
    );
  }

  const key: SigningKey = {
    privateKey,
    published: {
      kty: 'OKP',
      crv: 'Ed25519',
      x,
      kid: thumbprint(x),
      alg: 'EdDSA',
      use: 'sig',
    },
  };
  cached = { pem: configured, key };
  log('signingKey: loaded kid=%s', key.published.kid);
  return key;
};

export const isToolAssertionConfigured = (): boolean => {
  return signingKey() !== null;
};

/** The public half, for `GET /.well-known/tool-assertion-jwks.json`. */
export const toolAssertionJwks = (): { keys: PublishedKey[] } => {
  const key = signingKey();
  return { keys: key ? [key.published] : [] };
};

/** `<SOAT_HEADER_PREFIX>Tool-Assertion`. */
export const toolAssertionHeaderName = (): string => {
  return soatHeader('Tool-Assertion');
};

/**
 * Who sent a tool request. `context` is the call's `tool_context`: only its
 * reserved identity keys are read, because only those are server-derived — a
 * caller cannot address them on any entry point (`toolContext.ts`).
 */
export type ToolAssertionIdentity = {
  /** Public id; `null` for an inline (unpersisted) definition. */
  toolId: string | null;
  /** Public id of the tool's own project. */
  projectId: string;
  context?: Record<string, string>;
};

const encode = (value: object): string => {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
};

/** Origin and path only: a query string can carry a credential. */
const audienceOf = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
};

const identityClaims = (
  context: Record<string, string> | undefined
): Record<string, string> => {
  const claims: Record<string, string> = {};
  for (const key of RESERVED_TOOL_CONTEXT_KEYS) {
    const value = context?.[key];
    if (value) claims[key] = value;
  }
  return claims;
};

/**
 * The header carrying the assertion for one request, or nothing when the
 * deployment configures no key. Signed per request, since it binds the body
 * and the target.
 */
export const toolAssertionHeaders = (args: {
  identity: ToolAssertionIdentity;
  url: string;
  body: string;
}): Record<string, string> => {
  const key = signingKey();
  if (!key) return {};
  const name = toolAssertionHeaderName();

  const iat = Math.floor(Date.now() / 1000);
  const signingInput = `${encode({
    alg: 'EdDSA',
    typ: 'JWT',
    kid: key.published.kid,
  })}.${encode({
    iss: ISSUER,
    aud: audienceOf(args.url),
    iat,
    exp: iat + TOOL_ASSERTION_TTL_SECONDS,
    jti: crypto.randomUUID(),
    ...(args.identity.toolId ? { tool_id: args.identity.toolId } : {}),
    project_id: args.identity.projectId,
    ...identityClaims(args.identity.context),
    body_sha256: crypto
      .createHash('sha256')
      .update(args.body)
      .digest('base64url'),
  })}`;
  const signature = crypto
    .sign(null, Buffer.from(signingInput), key.privateKey)
    .toString('base64url');
  return { [name]: `${signingInput}.${signature}` };
};

import crypto from 'node:crypto';
import zlib from 'node:zlib';

import createDebug from 'debug';

import type { PolicySets } from './iam';
import { isPlainObject } from './plainObject';
import { isPolicySets } from './principalBound';
import { deriveSecretKey } from './signedTokens';

/**
 * The authority of the work a tool assertion was sent for: the policy sets a
 * callback presenting it is capped by, and the opaque principal it acts for.
 * Sealed with a key only this deployment derives, so a tool server that
 * verifies the assertion reads neither.
 */
export type AssertionAuthority = {
  sets: PolicySets;
  principal?: { type: string; id: string };
};

const log = createDebug('soat:assertionAuthority');

const IV_BYTES = 12;
const TAG_BYTES = 16;

const sealingKey = (): Buffer => {
  return deriveSecretKey({ info: 'soat tool-assertion authority' });
};

/** AES-256-GCM over the deflated JSON, as base64url `iv | tag | ciphertext`. */
export const sealAssertionAuthority = (args: {
  authority: AssertionAuthority;
}): string => {
  const { authority } = args;
  if (authority.sets.length === 0) {
    throw new Error('An assertion authority holds at least one policy set.');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealingKey(), iv);
  const plain = zlib.deflateRawSync(Buffer.from(JSON.stringify(authority)));
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
};

const isPrincipal = (value: unknown): value is { type: string; id: string } => {
  return (
    isPlainObject(value) &&
    typeof value.type === 'string' &&
    typeof value.id === 'string'
  );
};

const decrypt = (sealed: string): unknown => {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', sealingKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
    return JSON.parse(zlib.inflateRawSync(plain).toString('utf-8'));
  } catch {
    return null;
  }
};

/**
 * The authority a sealed claim holds, or `null` when it is absent, was not
 * sealed by this deployment, or holds no policy set: a callback is never left
 * uncapped by a claim that cannot be read.
 */
export const openAssertionAuthority = (args: {
  value: unknown;
}): AssertionAuthority | null => {
  const { value } = args;
  if (typeof value !== 'string' || value.length === 0) return null;
  const opened = decrypt(value);
  if (
    !isPlainObject(opened) ||
    !isPolicySets(opened.sets) ||
    (opened.principal !== undefined && !isPrincipal(opened.principal))
  ) {
    log('openAssertionAuthority: unreadable');
    return null;
  }
  return {
    sets: opened.sets,
    ...(opened.principal ? { principal: opened.principal } : {}),
  };
};

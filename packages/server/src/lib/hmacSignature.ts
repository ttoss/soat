import crypto from 'node:crypto';

import { soatHeader } from './headerPrefix';

/**
 * The one timestamped-HMAC scheme SOAT signs outbound requests with:
 *
 * `X-Soat-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<body>">`
 *
 * Binding the timestamp into the signed value lets a receiver reject a replayed
 * body by age, since an attacker cannot present an old body under a fresh
 * timestamp. A receiver recomputes the digest over `${t}.${rawBody}` — the
 * **raw** bytes it read, never a re-encoded parse.
 *
 * Extracted from the webhook dispatcher so the formation resource-type handler
 * protocol signs identically rather than growing a second scheme.
 */

/** `<SOAT_HEADER_PREFIX>Signature`. */
export const signatureHeader = (): string => {
  return soatHeader('Signature');
};

export const hmacHex = (args: { secret: string; value: string }): string => {
  return crypto
    .createHmac('sha256', args.secret)
    .update(args.value)
    .digest('hex');
};

/**
 * Signs a payload for one attempt. The timestamp is taken here rather than
 * passed in because it must be *this* attempt's: a retry reusing an earlier
 * timestamp would fall outside a receiver's tolerance window and be rejected as
 * a replay of itself.
 */
export const timestampedSignature = (args: {
  payload: string;
  secret: string;
}): string => {
  const timestamp = Math.floor(Date.now() / 1000);
  return `t=${timestamp},v1=${hmacHex({
    secret: args.secret,
    value: `${timestamp}.${args.payload}`,
  })}`;
};

/** How far a timestamp may sit from the receiver's clock, either way. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const digestsEqual = (args: { a: string; b: string }): boolean => {
  const a = Buffer.from(args.a);
  const b = Buffer.from(args.b);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * Verifies a {@link timestampedSignature} header over `rawBody`. Answers the
 * `v1` digest when it matches and `t` is within
 * {@link SIGNATURE_TOLERANCE_SECONDS} of `now`, else `null`.
 */
export const verifyTimestampedSignature = (args: {
  secret: string;
  rawBody: string;
  header: string;
  now?: Date;
}): string | null => {
  const elements = new Map(
    args.header.split(',').map((part) => {
      const separator = part.indexOf('=');
      return [part.slice(0, separator).trim(), part.slice(separator + 1)];
    })
  );
  const timestamp = elements.get('t');
  const digest = elements.get('v1');
  if (!timestamp || !/^\d+$/.test(timestamp) || !digest) return null;

  const nowSeconds = Math.floor((args.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
    return null;
  }

  const expected = hmacHex({
    secret: args.secret,
    value: `${timestamp}.${args.rawBody}`,
  });
  return digestsEqual({ a: digest, b: expected }) ? digest : null;
};

/** Verifies `sha256=<hex>` over the bare body; carries no timestamp. */
export const verifyBareBodySignature = (args: {
  secret: string;
  rawBody: string;
  header: string;
}): boolean => {
  return digestsEqual({
    a: args.header,
    b: `sha256=${hmacHex({ secret: args.secret, value: args.rawBody })}`,
  });
};

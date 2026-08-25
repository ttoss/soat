import crypto from 'node:crypto';

/**
 * The one timestamped-HMAC scheme SOAT signs outbound requests with.
 *
 * `X-Soat-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<body>">`
 *
 * Binding the timestamp into the signed value is what lets a receiver reject a
 * replayed body by age: the digest covers the timestamp, so an attacker cannot
 * present an old body under a fresh one. A receiver verifies by recomputing the
 * digest over `${t}.${rawBody}` — the **raw** bytes it read, never a re-encoded
 * parse of them.
 *
 * Extracted from the webhook dispatcher so the formation resource-type handler
 * protocol (#1078) signs identically rather than growing a second scheme with
 * its own subtly different string to sign.
 */

export const SIGNATURE_HEADER = 'X-Soat-Signature';

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

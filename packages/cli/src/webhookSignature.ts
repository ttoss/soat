import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verification of the signature headers SOAT puts on an outbound webhook
 * delivery, for the local `soat listen` listener.
 *
 * Two schemes are in play during the deprecation window:
 *
 * - `X-Soat-Signature-V2: t=<unix>,v1=<hex>` — the digest covers
 *   `<t>.<raw body>`, so the timestamp is authenticated and a subscriber can
 *   bound a replay by age.
 * - `X-Soat-Signature: sha256=<hex>` — deprecated, digest over the bare body,
 *   no replay bound.
 *
 * The v2 header wins when both are present; the fallback keeps `soat listen`
 * working against a server that has not been upgraded yet.
 */

export type SignatureScheme = 'v1' | 'v2';

export type SignatureInspection = {
  /** The header value that was checked, or `''` when neither header is present. */
  signature: string;
  scheme: SignatureScheme;
  /** `null` when no secret was supplied, so nothing was verified. */
  valid: boolean | null;
};

const digestMatches = (args: { expected: string; actual: string }) => {
  const expectedBuffer = Buffer.from(args.expected, 'utf8');
  const actualBuffer = Buffer.from(args.actual, 'utf8');

  if (expectedBuffer.length !== actualBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, actualBuffer);
};

/** Deprecated scheme: `sha256=<hex>` over the bare body. */
const verifyLegacySignature = (args: {
  secret: string;
  payload: string;
  header: string;
}) => {
  const expected = createHmac('sha256', args.secret)
    .update(args.payload)
    .digest('hex');
  return digestMatches({ expected, actual: args.header });
};

/**
 * Timestamped scheme: `t=<unix>,v1=<hex>` over `<t>.<body>`.
 *
 * The timestamp must be present, but its age is deliberately not enforced here:
 * this is a local debugging listener, and rejecting a delivery over clock skew
 * would read as a signing bug. A real subscriber should enforce a tolerance
 * window — the webhooks module docs show one.
 */
const verifyTimestampedSignature = (args: {
  secret: string;
  payload: string;
  header: string;
}) => {
  const elements = new Map(
    args.header.split(',').map((part) => {
      const separator = part.indexOf('=');
      return [part.slice(0, separator).trim(), part.slice(separator + 1)];
    })
  );

  const timestamp = elements.get('t');
  const digest = elements.get('v1');
  if (!timestamp || !digest) return false;

  const expected = createHmac('sha256', args.secret)
    .update(`${timestamp}.${args.payload}`)
    .digest('hex');
  return digestMatches({ expected, actual: digest });
};

const headerValue = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
};

/**
 * Picks the scheme a delivery used and verifies it, when a secret is supplied.
 */
export const inspectDeliverySignature = (args: {
  secret?: string;
  payload: string;
  headers: Record<string, string | string[] | undefined>;
}): SignatureInspection => {
  const timestamped = headerValue(args.headers['x-soat-signature-v2']);
  const legacy = headerValue(args.headers['x-soat-signature']);

  const scheme: SignatureScheme = timestamped ? 'v2' : 'v1';
  const signature = timestamped || legacy;

  if (!args.secret) {
    return { signature, scheme, valid: null };
  }

  const valid =
    scheme === 'v2'
      ? verifyTimestampedSignature({
          secret: args.secret,
          payload: args.payload,
          header: timestamped,
        })
      : verifyLegacySignature({
          secret: args.secret,
          payload: args.payload,
          header: legacy,
        });

  return { signature, scheme, valid };
};

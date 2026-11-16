import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verification of the `X-Soat-Signature` on a payload the local `soat listen`
 * listener receives. Webhook deliveries and triggers alike carry
 * `t=<unix>,v1=<hex>`, a digest over `<t>.<raw body>`; any other value is
 * invalid.
 */

export type SignatureInspection = {
  /** The header value that was checked, or `''` when the header is absent. */
  signature: string;
  /** `null` when no secret was supplied, so nothing was verified. */
  valid: boolean | null;
};

const digestMatches = (args: { expected: string; actual: string }) => {
  const expectedBuffer = Buffer.from(args.expected, 'utf8');
  const actualBuffer = Buffer.from(args.actual, 'utf8');

  if (expectedBuffer.length !== actualBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, actualBuffer);
};

/**
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

/** Verifies a delivery's signature, when a secret is supplied. */
export const inspectDeliverySignature = (args: {
  secret?: string;
  payload: string;
  headers: Record<string, string | string[] | undefined>;
}): SignatureInspection => {
  const signature = headerValue(args.headers['x-soat-signature']);

  if (!args.secret) {
    return { signature, valid: null };
  }

  const valid = verifyTimestampedSignature({
    secret: args.secret,
    payload: args.payload,
    header: signature,
  });

  return { signature, valid };
};

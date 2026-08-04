import crypto from 'node:crypto';

import type { AwsSigV4AuthConfig } from './toolAuthConfig';

const ALGORITHM = 'AWS4-HMAC-SHA256';

const sha256Hex = (value: string): string => {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
};

const hmac = (key: Buffer | string, value: string): Buffer => {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest();
};

// `encodeURIComponent` leaves `!'()*` unescaped, which RFC 3986 (and therefore
// SigV4's canonical form) requires escaped.
const rfc3986Encode = (value: string): string => {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => {
    return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
  });
};

/**
 * Canonical URI. Every service except S3 expects each path segment encoded
 * twice; `URL.pathname` has already applied the first pass, so encoding it
 * once more here yields the double-encoded form (`a%20b` → `a%2520b`).
 */
const buildCanonicalUri = (args: { pathname: string; service: string }) => {
  if (!args.pathname) return '/';
  if (args.service === 's3') return args.pathname;

  return args.pathname
    .split('/')
    .map((segment) => {
      return rfc3986Encode(segment);
    })
    .join('/');
};

const buildCanonicalQueryString = (searchParams: URLSearchParams): string => {
  const pairs = [...searchParams.entries()].map(([key, value]) => {
    return [rfc3986Encode(key), rfc3986Encode(value)] as const;
  });

  pairs.sort(([keyA, valueA], [keyB, valueB]) => {
    if (keyA !== keyB) return keyA < keyB ? -1 : 1;
    if (valueA === valueB) return 0;
    return valueA < valueB ? -1 : 1;
  });

  return pairs
    .map(([key, value]) => {
      return `${key}=${value}`;
    })
    .join('&');
};

const toAmzDate = (now: Date): { amzDate: string; dateStamp: string } => {
  const amzDate = `${now.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
};

/**
 * Only headers this signer fully controls are signed: `host`, `content-type`,
 * and the `x-amz-*` set it adds itself. Signing caller-supplied or
 * runtime-injected headers (tool-context headers, `Idempotency-Key`) would risk
 * a mismatch whenever `fetch` normalizes or adds one — and AWS verifies only
 * the headers named in `SignedHeaders`, so a narrower set is still valid.
 */
const buildSignedHeaderMap = (args: {
  url: URL;
  headers?: Record<string, string>;
  amzDate: string;
  payloadHash: string;
  auth: AwsSigV4AuthConfig;
}): Record<string, string> => {
  const signed: Record<string, string> = { host: args.url.host };

  for (const [name, value] of Object.entries(args.headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === 'content-type' || lower.startsWith('x-amz-')) {
      signed[lower] = String(value).trim();
    }
  }

  signed['x-amz-date'] = args.amzDate;

  if (args.auth.sessionToken) {
    signed['x-amz-security-token'] = args.auth.sessionToken;
  }

  // S3 requires the payload hash as a header; other services accept it and
  // ignore it, but sending it only where it is required keeps the signed set
  // minimal.
  if (args.auth.service === 's3') {
    signed['x-amz-content-sha256'] = args.payloadHash;
  }

  return signed;
};

export const signAwsSigV4 = (args: {
  auth: AwsSigV4AuthConfig;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  now: Date;
}): {
  headers: Record<string, string>;
  canonicalRequest: string;
  canonicalRequestHash: string;
  payloadHash: string;
} => {
  const url = new URL(args.url);
  const { amzDate, dateStamp } = toAmzDate(args.now);
  const payloadHash = sha256Hex(args.body ?? '');

  const signedHeaderMap = buildSignedHeaderMap({
    url,
    headers: args.headers,
    amzDate,
    payloadHash,
    auth: args.auth,
  });

  const sortedHeaderNames = Object.keys(signedHeaderMap).sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => {
      return `${name}:${signedHeaderMap[name]}\n`;
    })
    .join('');
  const signedHeaders = sortedHeaderNames.join(';');

  const canonicalRequest = [
    args.method.toUpperCase(),
    buildCanonicalUri({ pathname: url.pathname, service: args.auth.service }),
    buildCanonicalQueryString(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const canonicalRequestHash = sha256Hex(canonicalRequest);
  const credentialScope = `${dateStamp}/${args.auth.region}/${args.auth.service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join('\n');

  const signingKey = hmac(
    hmac(
      hmac(
        hmac(`AWS4${args.auth.secretAccessKey}`, dateStamp),
        args.auth.region
      ),
      args.auth.service
    ),
    'aws4_request'
  );
  const signature = crypto
    .createHmac('sha256', signingKey)
    .update(stringToSign, 'utf8')
    .digest('hex');

  const headers: Record<string, string> = {
    Authorization: `${ALGORITHM} Credential=${args.auth.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'X-Amz-Date': amzDate,
  };

  if (args.auth.sessionToken) {
    headers['X-Amz-Security-Token'] = args.auth.sessionToken;
  }

  if (args.auth.service === 's3') {
    headers['X-Amz-Content-Sha256'] = payloadHash;
  }

  return { headers, canonicalRequest, canonicalRequestHash, payloadHash };
};

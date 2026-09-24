import crypto from 'node:crypto';

import { isPlainObject } from './plainObject';

// Object keys sorted at every depth, so two semantically equal values serialize
// identically regardless of key order — a jsonb round trip reorders them.
const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => {
        return `${JSON.stringify(key)}:${stableStringify(value[key])}`;
      })
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/** SHA-256 hex of `value` in its key-order-independent JSON form. */
export const stableDigest = (value: unknown): string => {
  return crypto
    .createHash('sha256')
    .update(stableStringify(value))
    .digest('hex');
};

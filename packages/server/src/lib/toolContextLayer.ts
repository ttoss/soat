/**
 * An IAM token's `tool_context` layer: keys its issuer pins for every call the
 * token makes and every call that work starts. The layer travels on the
 * token's claim and on the `WorkAuthority` of work it starts, and is stamped
 * where a bag enters a tool call (`callResolvedTool`,
 * `resolveAgentToolBindings`), after admission saw the caller's own bag.
 */
import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';
import { readStringBag } from './stringBag';
import {
  assertAssignableToolContextKeys,
  withoutReservedPrefixKeys,
} from './toolContext';
import type { WorkAuthority } from './workAuthority';

/**
 * The layer `POST /iam/tokens` sends, validated: header-name keys, string
 * values, no server identity key. Keys under the deployment's reserved prefix
 * need `mayPinReserved`, which the issuer's grant answers. Undefined when
 * absent or empty.
 */
export const parseToolContextLayer = (args: {
  value: unknown;
  mayPinReserved: boolean;
}): Record<string, string> | undefined => {
  if (args.value === undefined || args.value === null) return undefined;
  if (!isPlainObject(args.value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'tool_context must be an object of string values.'
    );
  }
  const layer = readStringBag({ field: 'tool_context', value: args.value });
  assertAssignableToolContextKeys({
    field: 'tool_context',
    keys: Object.keys(layer),
    reservedPrefix: args.mayPinReserved ? 'allow' : 'refuse',
  });
  return Object.keys(layer).length === 0 ? undefined : layer;
};

/**
 * Reads a layer back from a token claim or a stored authority: undefined when
 * absent, null when it is not a bag of strings, which the reader refuses.
 */
export const readToolContextLayer = (
  value: unknown
): Record<string, string> | undefined | null => {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  if (
    !entries.every(([, entry]) => {
      return typeof entry === 'string';
    })
  ) {
    return null;
  }
  return Object.fromEntries(entries) as Record<string, string>;
};

/**
 * The bag a call forwards under `authority`: caller keys under the reserved
 * prefix, and every key the layer names, dropped in any casing; then the
 * layer stamped on top. Required `authority`, so an entry into a tool call
 * cannot skip stating whose layer it carries.
 */
export const stampToolContextLayer = (args: {
  toolContext?: Record<string, string>;
  authority: WorkAuthority | null;
}): Record<string, string> | undefined => {
  const layer = args.authority?.toolContext ?? null;
  if (!args.toolContext && !layer) return undefined;
  const pinned = new Set(
    Object.keys(layer ?? {}).map((key) => {
      return key.toLowerCase();
    })
  );
  const stripped = Object.fromEntries(
    Object.entries(withoutReservedPrefixKeys(args.toolContext ?? {})).filter(
      ([key]) => {
        return !pinned.has(key.toLowerCase());
      }
    )
  );
  const stamped = { ...stripped, ...layer };
  return Object.keys(stamped).length === 0 ? undefined : stamped;
};

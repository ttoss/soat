/**
 * An IAM token's `tool_context` layer: keys its issuer pins for every call the
 * token makes and every call that work starts. The layer travels on the
 * token's claim and on the `WorkAuthority` of work it starts, and is stamped
 * where a bag enters a tool call (`callResolvedTool`,
 * `resolveAgentToolBindings`), after admission saw the caller's own bag.
 */
import { isPlainObject } from './plainObject';
import {
  assertAssignableToolContextKeys,
  withoutReservedPrefixKeys,
} from './toolContext';
import type { WorkAuthority } from './workAuthority';

/**
 * The layer `POST /iam/tokens` sends, already read by `parseToolContextBody`:
 * header-name keys, no server identity key. Keys under the deployment's
 * reserved prefix need `mayPinReserved`, which the issuer's grant answers.
 * Undefined when absent or empty.
 */
export const parseToolContextLayer = (args: {
  toolContext: Record<string, string> | undefined;
  mayPinReserved: boolean;
}): Record<string, string> | undefined => {
  if (!args.toolContext) return undefined;
  const keys = Object.keys(args.toolContext);
  assertAssignableToolContextKeys({
    field: 'tool_context',
    keys,
    reservedPrefix: args.mayPinReserved ? 'allow' : 'refuse',
  });
  return keys.length === 0 ? undefined : args.toolContext;
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

/** `under` without every key `over` names, in any casing, then `over` on top. */
export const overlayToolContext = (args: {
  under: Record<string, string>;
  over: Record<string, string>;
}): Record<string, string> => {
  const pinned = new Set(
    Object.keys(args.over).map((key) => {
      return key.toLowerCase();
    })
  );
  const kept = Object.entries(args.under).filter(([key]) => {
    return !pinned.has(key.toLowerCase());
  });
  return { ...Object.fromEntries(kept), ...args.over };
};

/**
 * The layer an `On-Behalf-Of` callback carries: the credential's own, with the
 * layer of the work its assertion was sent for stamped on top.
 */
export const callbackToolContextLayer = (args: {
  credential?: Record<string, string>;
  asserted?: Record<string, string>;
}): Record<string, string> | undefined => {
  if (!args.asserted) return args.credential;
  return overlayToolContext({
    under: args.credential ?? {},
    over: args.asserted,
  });
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
  const stamped = overlayToolContext({
    under: withoutReservedPrefixKeys(args.toolContext ?? {}),
    over: layer ?? {},
  });
  return Object.keys(stamped).length === 0 ? undefined : stamped;
};

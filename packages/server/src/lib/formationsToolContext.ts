import { isFormationExpression } from './formation-modules/formationSpecLoader';
import { isPlainObject } from './plainObject';
import { assertNoReservedPrefixKeys } from './toolContext';

/** Every property that assigns `tool_context` keys, in any casing. */
const CARRIER_KEYS = new Set(['toolcontext', 'itemtoolcontext']);

const isCarrierKey = (key: string): boolean => {
  return CARRIER_KEYS.has(key.replace(/_/g, '').toLowerCase());
};

/**
 * Throws `INVALID_TOOL_CONTEXT_KEY` (400) when a resource's properties assign
 * a key under the reserved prefix in any bag, at any depth: a resource's own
 * `tool_context`, and a graph node's `item_tool_context`. By name rather than
 * per resource type, so a carrier a new type declares is held to it too.
 */
export const assertNoReservedToolContextKeysIn = (args: {
  value: unknown;
  path: string;
}): void => {
  if (Array.isArray(args.value)) {
    for (const [index, item] of args.value.entries()) {
      assertNoReservedToolContextKeysIn({
        value: item,
        path: `${args.path}[${index}]`,
      });
    }
    return;
  }
  if (!isPlainObject(args.value) || isFormationExpression(args.value)) return;
  for (const [key, value] of Object.entries(args.value)) {
    const path = `${args.path}.${key}`;
    if (
      isCarrierKey(key) &&
      isPlainObject(value) &&
      !isFormationExpression(value)
    ) {
      assertNoReservedPrefixKeys({ field: path, keys: Object.keys(value) });
    }
    assertNoReservedToolContextKeysIn({ value, path });
  }
};

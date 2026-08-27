import { isPlainObject } from './plainObject';

// A workflow's `states`/`transitions` are camelCase internally but authored
// snake_case on the wire. An explicit field-by-field mapper per
// `case-convention.md`: every renamed key is named below at its exact position,
// and anything unnamed — guards, JSON Logic bodies, `input_mapping`,
// `payload_writes`, unrecognized author keys — is copied as an opaque value, so
// its inner keys are never looked at. The key-blind recursive transform that
// used to live here is the construct that rule bans (#852).

/**
 * Moves `from` to `to` in place when present. Values — including whole nested
 * bags — travel untouched; only the one named key changes.
 */
const renameKey = (
  obj: Record<string, unknown>,
  from: string,
  to: string
): void => {
  if (from in obj) {
    obj[to] = obj[from];
    delete obj[from];
  }
};

type KeyRename = [wire: string, internal: string];

const DISPATCH_KEYS: KeyRename[] = [
  ['agent_id', 'agentId'],
  ['orchestration_id', 'orchestrationId'],
  ['tool_id', 'toolId'],
  ['operation_id', 'operationId'],
  // Renamed as a whole; the bag behind each is author-owned and stays opaque.
  ['input_mapping', 'inputMapping'],
  ['payload_writes', 'payloadWrites'],
];

const RETRY_KEYS: KeyRename[] = [
  ['max_attempts', 'maxAttempts'],
  ['backoff_seconds', 'backoffSeconds'],
  ['backoff_multiplier', 'backoffMultiplier'],
];

const ON_ENTER_KEYS: KeyRename[] = [
  ['on_complete', 'onComplete'],
  ['on_failure', 'onFailure'],
];

// One mapper serves states and transitions, so it carries both key sets; they
// are disjoint and keyed by presence.
const ITEM_KEYS: KeyRename[] = [
  ['stalled_after', 'stalledAfter'],
  ['on_enter', 'onEnter'],
  ['requires_approval', 'requiresApproval'],
];

const applyRenames = (
  value: unknown,
  renames: KeyRename[],
  direction: 'toCamel' | 'toSnake'
): Record<string, unknown> | null => {
  if (!isPlainObject(value)) return null;
  const out: Record<string, unknown> = { ...value };
  for (const [wire, internal] of renames) {
    if (direction === 'toCamel') {
      renameKey(out, wire, internal);
    } else {
      renameKey(out, internal, wire);
    }
  }
  return out;
};

const convertItem = (
  value: unknown,
  direction: 'toCamel' | 'toSnake'
): unknown => {
  const item = applyRenames(value, ITEM_KEYS, direction);
  if (!item) return value;

  const onEnterKey = direction === 'toCamel' ? 'onEnter' : 'on_enter';
  const onEnter = applyRenames(item[onEnterKey], ON_ENTER_KEYS, direction);
  if (!onEnter) return item;

  const dispatch = applyRenames(onEnter.dispatch, DISPATCH_KEYS, direction);
  if (dispatch) onEnter.dispatch = dispatch;

  const retry = applyRenames(onEnter.retry, RETRY_KEYS, direction);
  if (retry) onEnter.retry = retry;

  item[onEnterKey] = onEnter;
  return item;
};

/** Converts a raw wire `states`/`transitions` array (snake_case) to the internal camelCase shape. */
export const workflowCollectionToCamel = <T>(
  value: unknown
): T[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    return convertItem(item, 'toCamel');
  }) as T[];
};

/** Reverses {@link workflowCollectionToCamel} for a response body. */
export const workflowCollectionToSnake = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    return convertItem(item, 'toSnake');
  });
};

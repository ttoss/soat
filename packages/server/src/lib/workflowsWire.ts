import { isPlainObject } from './plainObject';

// ── Wire <-> internal conversion ─────────────────────────────────────────
//
// A workflow's `states`/`transitions` carry structural keys in camelCase
// internally (`stalledAfter`, `onEnter`, `onComplete`, `requiresApproval`,
// `agentId`) but are authored and read back snake_case on the wire — REST and
// formation templates alike. The conversion is an explicit field-by-field
// mapper (`case-convention.md`): every structural key that changes case is
// named below at its exact position, and everything the mapper does not name
// — a transition's `guard`, an on_complete rule's `when` (JSON Logic bodies),
// a dispatch's `input_mapping` (keys are the *target* run's own input field
// names) and `payload_writes`, and any unrecognized author key — is copied as
// an opaque **value**, so its inner keys are never even looked at. A key-blind
// recursive transform guarded by a skip list used to live here; that is the
// construct `case-convention.md` bans (#852, and #651/#690/#729/#737 before
// it). Shared by `rest/v1/workflows.ts` and
// `formation-modules/workflowsFormationModule.ts` — both boundaries face the
// identical shape.

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

// States and transitions run through the same collection mapper (both call
// sites convert the two arrays with one function), so the item mapper carries
// both key sets; they are disjoint and keyed by presence. An `OnCompleteRule`
// has no renames — `when` is opaque and `transition` is case-stable.
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

import { DomainError } from '../errors';

/**
 * Optimistic concurrency for every resource carrying a `version` counter.
 *
 * Two writers that read the same version and write different fields both
 * succeed today, and the second silently erases the first — the failure a
 * multi-writer corpus cannot detect after the fact, because the record it
 * would be detected from is the one that was overwritten. A precondition turns
 * that into a refusal the loser can see and retry.
 *
 * The guarantee has two halves, and both are needed:
 *
 *  - The **stated** precondition, read here from the request, refuses a write
 *    whose author read a version that is no longer current.
 *  - The **implied** precondition, applied by `resourceVersions` as a
 *    conditional `UPDATE … WHERE version = :expected` inside the write's
 *    transaction, refuses a write that lost a race it could not have seen.
 *
 * A caller that states nothing still gets the second, so concurrent writes to
 * one resource serialize whether or not anybody opted in.
 */

/** Header carrying the stated precondition. */
export const PRECONDITION_HEADER = 'if-match';

/** Body field carrying the stated precondition. */
export const PRECONDITION_FIELD = 'expected_version';

/**
 * `If-Match: *` means "any current version", which is the same as stating no
 * precondition at all: it asserts the resource exists, and the write's own
 * load has already established that.
 */
const ANY_VERSION = '*';

const invalid = (raw: string): never => {
  throw new DomainError(
    'VALIDATION_FAILED',
    `'${raw}' is not a version. If-Match is the integer version the resource is expected to hold, or '*' for any.`
  );
};

/**
 * Parses one stated precondition into a version number, or `null` for "none
 * stated".
 *
 * An entity tag is accepted quoted (`"3"`, `W/"3"`) as well as bare, because a
 * conforming HTTP client quotes what it puts in `If-Match` and a hand-written
 * `curl` does not. Both name the same version, so refusing one of them would
 * make the precondition a property of the client rather than of the request.
 */
const parseVersion = (raw: string): number | null => {
  const tag = raw.trim().replace(/^W\//i, '');
  if (tag === ANY_VERSION) return null;

  const unquoted =
    tag.length >= 2 && tag.startsWith('"') && tag.endsWith('"')
      ? tag.slice(1, -1)
      : tag;

  if (!/^\d+$/.test(unquoted)) return invalid(raw);

  const version = Number(unquoted);
  // A version counter starts at 1, so 0 names no version that can ever exist.
  if (version < 1) return invalid(raw);

  return version;
};

/**
 * Reads the precondition a request states, from the `If-Match` header or the
 * `expected_version` body field.
 *
 * Both spellings exist because both callers exist: `If-Match` is what an HTTP
 * client sends and the only place a body-less write can carry one, while
 * `expected_version` is what a tool call and a formation apply can set, and is
 * the one the OpenAPI spec can validate. They are the same precondition, so
 * stating both with different values is a contradiction rather than a
 * precedence question, and is refused instead of resolved.
 */
/** The precondition stated in the `If-Match` header, or `null` for none. */
const headerPrecondition = (
  headers: Record<string, string | string[] | undefined>
): number | null => {
  const raw = headers[PRECONDITION_HEADER];

  // A repeated header arrives as a list. Two values are two preconditions.
  if (Array.isArray(raw)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'If-Match was sent more than once. A write states one precondition.'
    );
  }

  if (typeof raw !== 'string' || raw.trim() === '') return null;

  return parseVersion(raw);
};

/** The precondition stated in the request body, or `null` for none. */
const bodyPrecondition = (body: unknown): number | null => {
  const raw =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)[PRECONDITION_FIELD]
      : undefined;

  if (raw === undefined || raw === null) return null;

  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${PRECONDITION_FIELD} must be an integer of at least 1, not ${JSON.stringify(raw)}. Omit it to state no precondition.`
    );
  }

  return raw;
};

export const readWritePrecondition = (args: {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}): number | null => {
  const fromHeader = headerPrecondition(args.headers);
  const fromBody = bodyPrecondition(args.body);

  if (fromBody === null) return fromHeader;

  if (fromHeader !== null && fromHeader !== fromBody) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `If-Match names version ${fromHeader} and ${PRECONDITION_FIELD} names version ${fromBody}. A write states one precondition.`
    );
  }

  return fromBody;
};

/**
 * The one refusal both halves raise, so a caller that lost a race and a caller
 * that named a stale version read the same code and the same `meta`.
 */
export const versionConflict = (args: {
  currentVersion: number;
  expectedVersion: number | null;
  resourceLabel: string;
  resourceId: string;
}): DomainError => {
  return new DomainError(
    'VERSION_CONFLICT',
    args.expectedVersion === null
      ? `${args.resourceLabel} '${args.resourceId}' was changed by a concurrent write; it is now at version ${args.currentVersion}.`
      : `${args.resourceLabel} '${args.resourceId}' is at version ${args.currentVersion}, not the expected version ${args.expectedVersion}.`,
    {
      current_version: args.currentVersion,
      ...(args.expectedVersion !== null && {
        expected_version: args.expectedVersion,
      }),
    }
  );
};

/**
 * Refuses a write whose stated precondition does not match the version the
 * resource holds.
 *
 * Called once the resource is loaded and before any field is written, so a
 * stale caller is answered without the write being attempted. It is not the
 * only guard: the conditional bump in `resourceVersions` catches the writer
 * that read a current version and then lost the race to commit.
 */
export const assertWritePrecondition = (args: {
  expectedVersion: number | null | undefined;
  currentVersion: number;
  resourceLabel: string;
  resourceId: string;
}): void => {
  if (args.expectedVersion === null || args.expectedVersion === undefined) {
    return;
  }
  if (args.expectedVersion === args.currentVersion) return;

  throw versionConflict({
    currentVersion: args.currentVersion,
    expectedVersion: args.expectedVersion,
    resourceLabel: args.resourceLabel,
    resourceId: args.resourceId,
  });
};

/**
 * What a versioned resource's write path accepts beyond its own fields: who
 * caused the change, what to label the version it archives, and which version
 * the caller believes it is changing.
 *
 * One type rather than one per module, so a resource that gains a version
 * counter gains the precondition with it instead of re-deciding whether to
 * accept one.
 */
export type VersionedWrite = {
  /** Required so every write path states its author; `null` is a platform write. */
  createdByUserId: number | null;
  versionLabel?: string | null;
  /** `null`/absent states no precondition; see {@link readWritePrecondition}. */
  expectedVersion?: number | null;
};

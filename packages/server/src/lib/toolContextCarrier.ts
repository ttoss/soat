import { assertSecretRefsExist, resolveSecretRefsInString } from './secrets';
import { sanitizeCallerToolContext } from './toolContext';

/**
 * The rule a **stored** `tool_context` follows, for every row that holds one —
 * a session, a task, an eval run, an orchestration run, a trigger.
 *
 * `toolContext.ts` owns what a bag *is*: the key grammar, the reserved identity
 * keys, the outbound header. This owns what a carrier *owes*: the bag is
 * checked and stripped once on the way in, and whether a `{{secret:...}}` inside
 * it is resolved at use is a property of the carrier rather than of the value.
 * Both live here because a carrier that answers them on its own answers them
 * differently, and the difference is only visible on the request that exploits
 * it.
 */

/**
 * The one ingress for a bag that is about to be written to a row: keys held to
 * the header-name grammar, reserved identity keys stripped in any casing, and —
 * for a carrier that resolves refs — every `{{secret:...}}` checked against this
 * project.
 *
 * `secretRefs` is the carrier's own answer to what a `{{secret:...}}` in a
 * stored value is: a reference this carrier resolves when it uses the bag
 * (`resolved`), or a literal it forwards as written (`verbatim`). It is stated
 * per carrier rather than inferred from the value, because the two readings
 * disagree about the same string — where nothing resolves it, refusing it for
 * naming a secret that does not exist refuses a value that is never read as a
 * ref.
 *
 * The strip is what the row's own lifetime makes necessary. Where a generation
 * runs, `buildGenerationContext` stamps the trusted identity over the caller's;
 * a stored bag may instead reach a tool directly — an orchestration `tool` node,
 * a trigger whose target is a tool — and there is nothing there to overwrite a
 * forged `session_id` with.
 *
 * The ref check is what the row's own schedule makes necessary: a stored value
 * is read on a firing nobody is watching, so a ref that names nothing has to
 * fail on the write that declared it.
 *
 * Returns `undefined` when nothing survives, so "no bag" has one representation.
 */
// A union rather than an optional `projectId`: the project is what a ref is
// checked against, so a carrier cannot declare `resolved` without naming one.
type AcceptToolContextArgs =
  | {
      toolContext?: Record<string, string> | null;
      secretRefs: 'verbatim';
    }
  | {
      toolContext?: Record<string, string> | null;
      secretRefs: 'resolved';
      projectId: number;
    };

export const acceptStoredToolContext = async (
  args: AcceptToolContextArgs
): Promise<Record<string, string> | undefined> => {
  const accepted = sanitizeCallerToolContext(args.toolContext);
  if (!accepted) return undefined;

  if (args.secretRefs === 'resolved') {
    await assertSecretRefsExist({ value: accepted, projectId: args.projectId });
  }

  return accepted;
};

/**
 * {@link acceptStoredToolContext} on an update, where the three values a caller
 * can send mean three different things: `undefined` leaves the stored bag
 * alone, `null` clears it, and an empty bag clears it too — so dropping a
 * credential from a live row needs no separate route.
 */
export const acceptStoredToolContextUpdate = async (
  args: AcceptToolContextArgs
): Promise<Record<string, string> | null | undefined> => {
  if (args.toolContext === undefined) return undefined;
  return (await acceptStoredToolContext(args)) ?? null;
};

/**
 * The bag to forward when a carrier is used: its stored half with every
 * `{{secret:...}}` resolved, overridden per key by the half supplied on the
 * request that drives this use.
 *
 * Resolved here rather than stored resolved, so rotating the secret changes
 * what the next use sends without touching the row, and the plaintext never
 * rests outside the secret store.
 *
 * Only the stored half resolves. A stored value is a declaration whose refs
 * were checked against this project by {@link acceptStoredToolContext}; a
 * supplied bag is caller data on a live request, and resolving it would let
 * anyone who may reach the entry point name any secret in the project and have
 * the server hand the plaintext to the target. A supplied key still wins,
 * forwarded as written.
 */
export const resolveStoredToolContext = async (args: {
  stored?: Record<string, string> | null;
  supplied?: Record<string, string> | null;
  projectId: number;
}): Promise<Record<string, string> | undefined> => {
  const resolvedStored = await Promise.all(
    Object.entries(args.stored ?? {}).map(
      async ([key, value]): Promise<[string, string]> => {
        return [
          key,
          await resolveSecretRefsInString({ value, projectId: args.projectId }),
        ];
      }
    )
  );

  const merged = {
    ...Object.fromEntries(resolvedStored),
    ...(args.supplied ?? {}),
  };
  return Object.keys(merged).length === 0 ? undefined : merged;
};

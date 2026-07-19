import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { computeDetachedGuardrailIds } from 'src/lib/guardrails';

/**
 * Parses a request-body `guardrail_ids` value into the shape the lib update
 * functions expect: `undefined` (field absent — leave attachments untouched),
 * `null` / `[]` (clear all), or a string array. Non-array, non-null values are
 * treated as absent.
 */
export const parseGuardrailIds = (
  value: unknown
): string[] | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return value as string[];
  return undefined;
};

/**
 * Enforces the attach/detach permission asymmetry (guardrails.md — Attachment):
 * adding a guardrail id can only tighten posture and needs just the carrying
 * resource's update permission (already checked to reach this handler), while
 * removing an id at any scope additionally requires `guardrails:DetachGuardrail`
 * — so a floor set at one scope can't be silently lowered from another.
 *
 * A no-op unless `next` actually drops an id from `current`. Throws
 * `DomainError('FORBIDDEN')` (403) when a detach is attempted without the
 * permission.
 */
export const assertGuardrailDetachAllowed = async (args: {
  ctx: Context;
  projectPublicId: string;
  current: string[] | null | undefined;
  next: string[] | null | undefined;
}): Promise<void> => {
  const detached = computeDetachedGuardrailIds({
    current: args.current,
    next: args.next,
  });
  if (detached.length === 0) return;

  if (!args.ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  const allowed = await args.ctx.authUser.isAllowed({
    projectPublicId: args.projectPublicId,
    action: 'guardrails:DetachGuardrail',
    // Probe with the project's SRN so project-scoped policies grant the detach,
    // consistent with the resolveProjectIds / getProject SRN convention.
    resource: `soat:${args.projectPublicId}:*:*`,
  });
  if (!allowed) {
    throw new DomainError(
      'FORBIDDEN',
      'Detaching a guardrail requires the guardrails:DetachGuardrail permission.',
      { detached }
    );
  }
};

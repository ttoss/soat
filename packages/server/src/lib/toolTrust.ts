import { db } from '../db';
import type { IsAllowedFn } from '../middleware/authProjectResolvers';
import { assertActionsHeld } from './writerRule';

/**
 * Declaring a tool's output trusted loosens every guardrail that reads
 * `runtime.generations.untrusted_tool_results`, as removing a guardrail does,
 * so it needs the same action.
 */
export const TRUSTED_OUTPUT_ACTION = 'guardrails:DetachGuardrail';

/**
 * The one check for a write that sets `trusted_output: true`, on a stored or
 * an inline tool: `ACTION_NOT_HELD` without {@link TRUSTED_OUTPUT_ACTION}.
 */
export const assertTrustedOutputAllowed = async (args: {
  trustedOutput: boolean | null | undefined;
  projectId: number;
  isAllowed: IsAllowedFn;
}): Promise<void> => {
  if (args.trustedOutput !== true) return;
  const project = await db.Project.findByPk(args.projectId, {
    attributes: ['publicId'],
    rejectOnEmpty: true,
  });
  await assertActionsHeld({
    isAllowed: args.isAllowed,
    projectPublicId: project.publicId,
    actions: [
      {
        action: TRUSTED_OUTPUT_ACTION,
        resourceType: 'guardrail',
        resourceId: '*',
      },
    ],
  });
};

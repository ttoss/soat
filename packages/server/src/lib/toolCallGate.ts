import type { AgentAuthority } from './agentAuthority';
import { buildSrn } from './iam';
import { assertAllowedUnder, turnAuthority } from './turnAuthority';
import { type WorkAuthority, workAuthorityMissing } from './workAuthority';

/**
 * The gate every stored tool's call crosses before it reaches anything, on
 * both surfaces (an agent's turn, `callTool`): `tools:CallTool` on the tool,
 * in the project the call runs in, under the turn's authority, whatever the
 * tool's type. An `inline` definition is the request's own and has no tool to
 * check.
 */
export const gateToolCall = async (args: {
  tool: { publicId: string } | 'inline';
  callingProjectPublicId: string;
  authority: WorkAuthority | null;
  agentAuthority?: AgentAuthority;
}): Promise<void> => {
  if (args.tool === 'inline') return;
  if (!args.authority) {
    throw workAuthorityMissing({
      work: `The call to tool '${args.tool.publicId}'`,
    });
  }
  await assertAllowedUnder({
    authority: turnAuthority(args),
    checks: [
      {
        projectPublicId: args.callingProjectPublicId,
        action: 'tools:CallTool',
        resource: buildSrn({
          projectPublicId: args.callingProjectPublicId,
          resourceType: 'tool',
          resourceId: args.tool.publicId,
        }),
      },
    ],
  });
};

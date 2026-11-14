import type { AgentAuthority } from './agentAuthority';
import type { AgentToolType } from './agentToolResolver';
import { buildSrn } from './iam';
import { assertAllowedUnder, turnAuthority } from './turnAuthority';
import { type WorkAuthority, workAuthorityMissing } from './workAuthority';

/**
 * What a call of each tool type is authorized by: `tools:CallTool` on the tool
 * where it runs (`call`); the route the action dispatches to, under the same
 * authority (`route`); or the client that runs it (`client`).
 */
const TOOL_CALL_AUTHORIZATION: Record<
  AgentToolType,
  'call' | 'route' | 'client'
> = {
  http: 'call',
  mcp: 'call',
  pipeline: 'call',
  builtin: 'route',
  client: 'client',
};

/**
 * The gate every stored tool's call crosses before it reaches anything, on
 * both surfaces (an agent's turn, `callTool`): `tools:CallTool` on the tool,
 * in the project the call runs in, under the turn's authority. A type nothing
 * classifies is checked as a call. An `inline` definition is the request's
 * own and has no tool to check.
 */
export const gateToolCall = async (args: {
  type: string;
  tool: { publicId: string } | 'inline';
  callingProjectPublicId: string;
  authority: WorkAuthority | null;
  agentAuthority?: AgentAuthority;
}): Promise<void> => {
  const authorization = Object.hasOwn(TOOL_CALL_AUTHORIZATION, args.type)
    ? TOOL_CALL_AUTHORIZATION[args.type as AgentToolType]
    : 'call';
  if (authorization !== 'call' || args.tool === 'inline') return;
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

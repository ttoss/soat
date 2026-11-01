/**
 * An `mcp` tool's actions as a binding of it exposes them, read from its
 * server: the agent surface (`resolveMcpTools`) without a turn to attach it to.
 */
import { DomainError } from '../errors';
import { boundMcpTools, exposedMcpInputSchema } from './agentToolResolverMcp';
import { fetchMcpToolListing } from './mcpToolListing';
import { openMcpTransport } from './mcpTransport';
import { tools } from './tools';

export type ToolAction = {
  name: string;
  description: string | null;
  input_schema: object;
};

const noopLogToolCallingError = () => {};

export const listToolActions = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<{ data: ToolAction[] }> => {
  const tool = await tools.getByPublicId(args);
  const mcp = tool.mcp as {
    url?: string;
    headers?: Record<string, string>;
  } | null;
  if (tool.type !== 'mcp' || !mcp?.url) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'Only an mcp tool lists its actions.'
    );
  }

  const transport = await openMcpTransport({
    mcp: { url: mcp.url, headers: mcp.headers },
    meter: {
      projectId: tool.projectId,
      toolId: tool.publicId,
      workId: null,
      attribution: {},
    },
    contextKeys: tool.contextKeys,
  });
  let failure = 'tools/list failed';
  const listing = await fetchMcpToolListing({
    transport,
    logToolCallingError: noopLogToolCallingError,
    reportResolutionFailure: ({ reason }) => {
      failure = reason;
    },
  });
  if (!listing) {
    throw new DomainError('MCP_TOOL_ERROR', failure, {
      mcp_tool: 'tools/list',
      mcp_url: transport.url,
    });
  }

  const bound = await boundMcpTools({ listing, typedTool: tool, transport });
  return {
    data: bound.map((mcpTool) => {
      return {
        name: mcpTool.name,
        description: mcpTool.description ?? null,
        input_schema: exposedMcpInputSchema({
          mcpTool,
          presetParameters: tool.presetParameters,
        }).inputSchema,
      };
    }),
  };
};

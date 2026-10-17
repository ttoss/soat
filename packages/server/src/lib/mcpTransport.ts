import createDebug from 'debug';

import { db } from '../db';
import { SOAT_TOOL_CALL_TIMEOUT_MS } from './externalToolCall';
import { withRequestIdHeader } from './requestCorrelation';
import { resolveSecretRefsInString } from './secrets';
import {
  isToolAssertionConfigured,
  toolAssertionHeaderName,
  toolAssertionHeaders,
  type ToolAssertionIdentity,
} from './toolAssertion';
import { buildContextHeaders } from './toolContext';
import { fetchWithEgressGuard } from './toolEgress';
import { resolveToolHeaderTemplates } from './toolTemplates';
import type { ToolExecutionMeter } from './usageToolRecording';

const log = createDebug('soat:mcpTransport');

/**
 * The one way an `mcp` tool reaches its server: the resolved URL and headers,
 * and who is sending. Every request — `tools/list`, a deferred `describe`, a
 * `tools/call` — goes through `postMcp`, which is what signs it
 * (`toolAssertion.ts`); `tests/harness/mcpTransport.test.mjs` holds the rest
 * of `lib/` off the network for MCP.
 */
export type McpTransport = {
  url: string;
  headers: Record<string, string>;
  identity: ToolAssertionIdentity | null;
};

const identityOf = async (args: {
  meter: ToolExecutionMeter;
  toolContext?: Record<string, string>;
}): Promise<ToolAssertionIdentity> => {
  const project = await db.Project.findByPk(args.meter.projectId, {
    attributes: ['publicId'],
  });
  if (!project) {
    throw new Error(`Tool project ${args.meter.projectId} does not exist.`);
  }
  return {
    toolId: args.meter.toolId,
    projectId: project.publicId,
    context: args.toolContext,
  };
};

/**
 * Resolves the binding's `{{secret:}}` and `{{context:}}` references and adds
 * the context headers, at the point of use, so the stored config keeps the
 * references. Throws a missing context key or secret before anything is sent.
 */
export const openMcpTransport = async (args: {
  mcp: { url: string; headers?: Record<string, string> | null };
  meter: ToolExecutionMeter;
  toolContext?: Record<string, string>;
  contextKeys?: string[] | null;
}): Promise<McpTransport> => {
  const { projectId } = args.meter;
  const url = await resolveSecretRefsInString({
    value: args.mcp.url,
    projectId,
  });
  const resolved = await resolveToolHeaderTemplates({
    record: args.mcp.headers ?? undefined,
    projectId,
    toolContext: args.toolContext,
  });
  const headers = withRequestIdHeader({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(resolved ?? {}),
    ...buildContextHeaders({
      toolContext: args.toolContext,
      contextKeys: args.contextKeys,
    }),
  });
  if (!isToolAssertionConfigured()) {
    return { url, headers, identity: null };
  }
  // Validated here so a bad name fails before the first request, not on it.
  toolAssertionHeaderName();
  const identity = await identityOf(args);
  log(
    'openMcpTransport: toolId=%s projectId=%s',
    identity.toolId,
    identity.projectId
  );
  return { url, headers, identity };
};

/**
 * Drops any header of the assertion's name the tool or a context key wrote, in
 * every casing: `fetch` would join two spellings into one value.
 */
const withoutAssertionHeader = (
  headers: Record<string, string>
): Record<string, string> => {
  const name = toolAssertionHeaderName().toLowerCase();
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => {
      return key.toLowerCase() !== name;
    })
  );
};

/** One JSON-RPC request to the server, signed when the deployment signs. */
export const postMcp = (args: {
  transport: McpTransport;
  body: string;
  onRequest?: () => void;
}): Promise<Response> => {
  const { transport } = args;
  const assertion = transport.identity
    ? toolAssertionHeaders({
        identity: transport.identity,
        url: transport.url,
        body: args.body,
      })
    : {};
  const headers = transport.identity
    ? { ...withoutAssertionHeader(transport.headers), ...assertion }
    : transport.headers;
  return fetchWithEgressGuard(
    transport.url,
    {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(SOAT_TOOL_CALL_TIMEOUT_MS),
      body: args.body,
    },
    // Its `aud` is this URL, so another origin holding it could replay it here.
    { onRequest: args.onRequest, credentialHeaders: Object.keys(assertion) }
  );
};

import createDebug from 'debug';

import { db } from '../db';
import { resolveSenderAuthority } from './assertionSender';
import { withOutboundToolHeaders } from './causationHeader';
import { SOAT_TOOL_CALL_TIMEOUT_MS } from './externalToolCall';
import { resolveSecretRefsWithValues } from './secrets';
import {
  isToolAssertionConfigured,
  toolAssertionHeaderName,
  toolAssertionHeaders,
  type ToolAssertionIdentity,
} from './toolAssertion';
import { buildContextHeaders } from './toolContext';
import { fetchWithEgressGuard } from './toolEgress';
import type { ToolTrust } from './toolErrorRelay';
import {
  resolveToolHeaderTemplates,
  secretBearingHeaderNames,
} from './toolTemplates';
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
  // As authored, `{{secret:}}` references kept: what errors and logs name.
  url: string;
  // `url` with its references resolved: what is sent, and nothing else.
  fetchUrl: string;
  // The `{{secret:}}` values resolved into `fetchUrl`, by secret id.
  urlSecrets: ReadonlyMap<string, string>;
  headers: Record<string, string>;
  // The `headers` whose template names a secret: never sent to another origin.
  credentialHeaders: readonly string[];
  identity: ToolAssertionIdentity | null;
  // Who registered the server: how its structured errors are relayed.
  trust: ToolTrust;
};

type McpConfig = {
  url: string;
  headers?: Record<string, string> | null;
  forward_principal?: boolean;
};

const identityOf = async (args: {
  mcp: McpConfig;
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
    agentId: args.meter.attribution.agentId,
    generationId: args.meter.attribution.generationId,
    workId: args.meter.workId,
    context: args.toolContext,
    authority: await resolveSenderAuthority({
      sender: args.meter.sender,
      projectPublicId: project.publicId,
    }),
    forwardPrincipal: args.mcp.forward_principal === true,
  };
};

/**
 * Resolves the binding's `{{secret:}}` and `{{context:}}` references and adds
 * the context headers, at the point of use, so the stored config keeps the
 * references. Throws a missing context key or secret before anything is sent.
 */
export const openMcpTransport = async (args: {
  mcp: McpConfig;
  meter: ToolExecutionMeter;
  toolContext?: Record<string, string>;
  contextKeys?: string[] | null;
  trust: ToolTrust;
}): Promise<McpTransport> => {
  const { projectId } = args.meter;
  const { trust } = args;
  const { url } = args.mcp;
  const { value: fetchUrl, secrets: urlSecrets } =
    await resolveSecretRefsWithValues({ value: url, projectId });
  const resolved = await resolveToolHeaderTemplates({
    record: args.mcp.headers ?? undefined,
    projectId,
    toolContext: args.toolContext,
  });
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(resolved ?? {}),
    ...buildContextHeaders({
      toolContext: args.toolContext,
      contextKeys: args.contextKeys,
    }),
  };
  const credentialHeaders = secretBearingHeaderNames(args.mcp.headers);
  if (!isToolAssertionConfigured()) {
    return {
      url,
      fetchUrl,
      urlSecrets,
      headers,
      credentialHeaders,
      identity: null,
      trust,
    };
  }
  // Validated here so a bad name fails before the first request, not on it.
  toolAssertionHeaderName();
  const identity = await identityOf(args);
  log(
    'openMcpTransport: toolId=%s projectId=%s',
    identity.toolId,
    identity.projectId
  );
  return {
    url,
    fetchUrl,
    urlSecrets,
    headers,
    credentialHeaders,
    identity,
    trust,
  };
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
  /** The calling work's own cancellation, on top of the call timeout. */
  signal?: AbortSignal;
}): Promise<Response> => {
  const { transport } = args;
  const assertion = transport.identity
    ? toolAssertionHeaders({
        identity: transport.identity,
        url: transport.fetchUrl,
        body: args.body,
      })
    : {};
  // Per request, not at open: the chain is the one the sending work runs in.
  const sent = withOutboundToolHeaders(transport.headers);
  const headers = transport.identity
    ? { ...withoutAssertionHeader(sent), ...assertion }
    : sent;
  return fetchWithEgressGuard(
    transport.fetchUrl,
    {
      method: 'POST',
      headers,
      signal: args.signal
        ? AbortSignal.any([
            args.signal,
            AbortSignal.timeout(SOAT_TOOL_CALL_TIMEOUT_MS),
          ])
        : AbortSignal.timeout(SOAT_TOOL_CALL_TIMEOUT_MS),
      body: args.body,
    },
    // The assertion's `aud` is this URL, so another origin could replay it here.
    {
      onRequest: args.onRequest,
      credentialHeaders: [
        ...transport.credentialHeaders,
        ...Object.keys(assertion),
      ],
      secrets: transport.urlSecrets,
    }
  );
};

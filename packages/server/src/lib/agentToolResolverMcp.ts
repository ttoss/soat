/**
 * Resolving an `mcp` tool binding into AI-SDK tools, and calling one.
 *
 * Separate from `agentToolResolverExternalTools.ts`, which holds the `builtin`
 * (SOAT) resolution: the two share nothing but the shape of the error callback,
 * and together they exceed the module ceiling. The protocol reading itself
 * lives in `mcpProtocol.ts` and `mcpToolListing.ts`.
 */
import type { JSONSchema7, JSONValue, Tool } from 'ai';
import { jsonSchema, tool } from 'ai';

import { DomainError } from '../errors';
import type { LogToolCallingError } from './externalToolCall';
import { toToolUnreachableError } from './httpToolError';
import {
  type DeferredProxy,
  describeDeferredTools,
  findDeferredProxy,
  innerToolName,
} from './mcpDeferredProxy';
import type { McpDefinitionGate } from './mcpDefinitionPins';
import { parseJsonRpcBody, readMcpCallResult } from './mcpProtocol';
import { fetchMcpToolListing, type McpToolListing } from './mcpToolListing';
import { type McpTransport, postMcp } from './mcpTransport';
import {
  GATE_PRESETS,
  mergePresetParameters,
  presetParametersForAction,
  presetsDeclaredBy,
  stripPresetKeysFromSchema,
  type ToolWithGatePresets,
} from './toolPresetParameters';
import {
  resolvePresetParametersForCall,
  resolvePresetParametersForGate,
} from './toolTemplates';
import {
  meterToolExecution,
  type ToolExecutionMeter,
} from './usageToolRecording';

/** The `tools/call` request, sent straight or through a deferred server's `call`. */
const toolsCallBody = (args: {
  viaCall?: string;
  toolName: string;
  callArgs: unknown;
}): string => {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: args.viaCall
      ? {
          name: args.viaCall,
          arguments: { name: args.toolName, arguments: args.callArgs },
        }
      : { name: args.toolName, arguments: args.callArgs },
  });
};

/**
 * A deferred server's `call` target, held to the binding (refused) and to the
 * pins (answered with the unavailable note instead of reaching the server).
 */
const proxyCallRefusal = (args: {
  callArgs: unknown;
  allowInner?: (name: string) => boolean;
  refuseInner?: McpDefinitionGate['refuseCall'];
}): string | null => {
  const inner = innerToolName(args.callArgs);
  if (args.allowInner && (inner === undefined || !args.allowInner(inner))) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `action "${inner ?? ''}" is not available on this tool.`
    );
  }
  return inner === undefined ? null : (args.refuseInner?.(inner) ?? null);
};

/** One `tools/call`, metered as the action it reaches. */
const sendMcpCall = (args: {
  transport: McpTransport;
  mcpToolName: string;
  meter: ToolExecutionMeter;
  viaCall?: string;
  proxyCall?: boolean;
  callArgs: unknown;
  inner?: string;
  signal?: AbortSignal;
}) => {
  return meterToolExecution({
    meter: args.meter,
    send: async (markSent) => {
      const callResponse = await postMcp({
        transport: args.transport,
        body: toolsCallBody({
          viaCall: args.viaCall,
          toolName: args.mcpToolName,
          callArgs: args.callArgs,
        }),
        signal: args.signal,
        onRequest: () => {
          markSent({
            input: args.callArgs,
            action: args.proxyCall ? args.inner : args.mcpToolName,
          });
        },
      });
      return readMcpCallResult({
        body: await parseJsonRpcBody({
          response: callResponse,
          url: args.transport.url,
        }),
        toolName: args.mcpToolName,
        url: args.transport.url,
        trust: args.transport.trust,
      });
    },
  });
};

export const buildMcpToolExecute = (args: {
  transport: McpTransport;
  mcpToolName: string;
  meter: ToolExecutionMeter;
  presetParameters?: object | null;
  // A `{{context:}}` token in a preset resolves against this call's context and
  // is retyped by the tool's schema — at call time, so a missing key fails this
  // call rather than the resolution of every tool the agent has.
  toolContext?: Record<string, string>;
  presetSchema?: unknown;
  logToolCallingError: LogToolCallingError;
  /** Sends the call through a deferred server's proxy; see `mcpDeferredProxy.ts`. */
  viaCall?: string;
  /** On a deferred server's own `call`: whether the tool it targets is bound. */
  allowInner?: (name: string) => boolean;
  /**
   * This is a deferred server's own `call`, so the action metered is the tool
   * it targets — the name `allowInner` holds to the binding.
   */
  proxyCall?: boolean;
  /** On a deferred server's own `call`: the note answered instead, if any. */
  refuseInner?: McpDefinitionGate['refuseCall'];
  /** On a deferred server's own `describe`: the result as the model gets it. */
  reviewResult?: McpDefinitionGate['reviewDescribed'];
}) => {
  return async (toolArgs: unknown, options?: { abortSignal?: AbortSignal }) => {
    const presetParameters = resolvePresetParametersForCall({
      presetParameters: args.presetParameters,
      toolContext: args.toolContext,
      toolName: args.mcpToolName,
      schema: args.presetSchema,
    });
    const callArgs = presetParameters
      ? mergePresetParameters({ presetParameters, input: toolArgs })
      : toolArgs;
    const refusal = proxyCallRefusal({ ...args, callArgs });
    if (refusal !== null) return refusal;
    try {
      const result = await sendMcpCall({
        ...args,
        callArgs,
        inner: innerToolName(callArgs),
        signal: options?.abortSignal,
      });
      return args.reviewResult ? await args.reviewResult(result) : result;
    } catch (error) {
      args.logToolCallingError({
        toolName: args.mcpToolName,
        toolType: 'mcp',
        url: args.transport.url,
        method: 'POST',
        error,
      });
      throw (
        toToolUnreachableError({
          error,
          url: args.transport.url,
          method: 'POST',
        }) ?? error
      );
    }
  };
};

/**
 * What the server says about the tool that the model is not shown.
 *
 * The AI SDK sends the provider `name`, `description` and `inputSchema` only,
 * so this rides along on the resolved tool and onto its call parts — which is
 * where a gating mechanism reading `annotations.destructiveHint` would look.
 */
const toolMetadata = (
  mcpTool: McpToolListing
): Record<string, JSONValue> | undefined => {
  const metadata = {
    ...(mcpTool.annotations ? { annotations: mcpTool.annotations } : {}),
    ...(mcpTool._meta ? { meta: mcpTool._meta } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
};

/**
 * An action's input schema as the binding exposes it: the presets the schema
 * declares are pinned, so they are hidden from whoever supplies the input.
 */
export const exposedMcpInputSchema = (args: {
  mcpTool: McpToolListing;
  presetParameters?: object | null;
}): {
  presetParameters: Record<string, unknown> | null;
  inputSchema: JSONSchema7;
} => {
  const presetParameters = presetsDeclaredBy({
    presetParameters: args.presetParameters,
    schema: args.mcpTool.inputSchema,
  });
  return {
    presetParameters,
    inputSchema: stripPresetKeysFromSchema(
      (args.mcpTool.inputSchema ?? {
        type: 'object',
        properties: {},
      }) as JSONSchema7,
      presetParameters
    ),
  };
};

/**
 * One listed MCP tool, as the model sees it and as it dispatches. Its schema,
 * its dispatch and its guardrail gate all read the presets this action
 * declares, worked out once here.
 */
const buildMcpToolEntry = (args: {
  mcpTool: McpToolListing;
  transport: McpTransport;
  meter: ToolExecutionMeter;
  presetParameters?: object | null;
  toolContext?: Record<string, string>;
  logToolCallingError: LogToolCallingError;
  viaCall?: string;
  allowInner?: (name: string) => boolean;
  proxyCall?: boolean;
  refuseInner?: McpDefinitionGate['refuseCall'];
  reviewResult?: McpDefinitionGate['reviewDescribed'];
}): ToolWithGatePresets => {
  const { mcpTool } = args;
  const { presetParameters, inputSchema } = exposedMcpInputSchema(args);
  const entry = {
    description: mcpTool.description ?? undefined,
    title: mcpTool.title,
    metadata: toolMetadata(mcpTool),
    inputSchema: jsonSchema(inputSchema),
    execute: buildMcpToolExecute({
      transport: args.transport,
      mcpToolName: mcpTool.name,
      meter: args.meter,
      presetParameters,
      toolContext: args.toolContext,
      presetSchema: mcpTool.inputSchema,
      logToolCallingError: args.logToolCallingError,
      viaCall: args.viaCall,
      allowInner: args.allowInner,
      proxyCall: args.proxyCall,
      refuseInner: args.refuseInner,
      reviewResult: args.reviewResult,
    }),
  };

  // Two calls rather than an optional key: `outputSchema` is what the SDK
  // infers a tool's output type from, and an `outputSchema: undefined` in the
  // literal makes that inference `never`.
  const built = mcpTool.outputSchema
    ? tool({
        ...entry,
        outputSchema: jsonSchema<unknown>(mcpTool.outputSchema as JSONSchema7),
      })
    : tool(entry);
  return {
    ...built,
    [GATE_PRESETS]: resolvePresetParametersForGate({
      presetParameters,
      toolContext: args.toolContext,
      toolName: mcpTool.name,
      schema: mcpTool.inputSchema,
    }),
  };
};

/** The binding's allowlist and denylist, as one predicate over tool names. */
const buildActionFilter = (typedTool: {
  actions?: string[] | null;
  deniedActions?: string[] | null;
}): ((name: string) => boolean) => {
  const allowed = typedTool.actions != null ? new Set(typedTool.actions) : null;
  const denied =
    typedTool.deniedActions != null ? new Set(typedTool.deniedActions) : null;
  return (name) => {
    if (allowed && !allowed.has(name)) return false;
    return !denied?.has(name);
  };
};

/**
 * The tools a binding attaches. On a deferred server an allowlist names tools
 * behind the proxy, so those are described and attached by name, and the
 * proxies themselves are not; without one, the listing is attached as listed
 * and its `call` checks each target against the binding (`allowInner`).
 */
export const boundMcpTools = async (args: {
  listing: McpToolListing[];
  typedTool: { actions?: string[] | null; deniedActions?: string[] | null };
  transport: McpTransport;
}): Promise<McpToolListing[]> => {
  const isBound = buildActionFilter(args.typedTool);
  const proxy = findDeferredProxy(args.listing);
  const { actions } = args.typedTool;
  const listed = args.listing.filter((mcpTool) => {
    return isBound(mcpTool.name);
  });
  if (!proxy || actions == null) return listed;

  const listedNames = new Set(
    args.listing.map((mcpTool) => {
      return mcpTool.name;
    })
  );
  const behindProxy = await describeDeferredTools({
    transport: args.transport,
    proxy,
    names: actions.filter((name) => {
      return !listedNames.has(name);
    }),
  });
  const proxyNames = new Set([proxy.callName, proxy.describeName]);
  return [
    ...listed.filter((mcpTool) => {
      return !proxyNames.has(mcpTool.name);
    }),
    ...behindProxy.filter((mcpTool) => {
      return isBound(mcpTool.name);
    }),
  ];
};

/**
 * How a tool on a deferred server dispatches: through the proxy's `call` when
 * it was described rather than listed; as the proxy itself, held to the binding
 * and to the pins.
 */
const proxyRole = (args: {
  proxy: DeferredProxy;
  listing: McpToolListing[];
  mcpTool: McpToolListing;
  isBound: (name: string) => boolean;
  definitions?: McpDefinitionGate | null;
}) => {
  const { proxy, mcpTool, definitions } = args;
  if (!args.listing.includes(mcpTool)) return { viaCall: proxy.callName };
  if (mcpTool.name === proxy.callName) {
    return {
      allowInner: args.isBound,
      proxyCall: true,
      refuseInner: definitions?.refuseCall,
    };
  }
  if (mcpTool.name === proxy.describeName) {
    return { reviewResult: definitions?.reviewDescribed };
  }
  return {};
};

const emptySurfaceReason = (args: {
  listing: McpToolListing[];
  withheld: Set<string>;
}): string => {
  if (args.listing.length === 0) return 'tools/list returned no tools';
  if (args.withheld.size > 0) {
    return 'every action was withheld: its definition differs from its pin';
  }
  return `every tool tools/list returned was excluded by the binding's actions/denied_actions`;
};

export const resolveMcpTools = async (args: {
  transport: McpTransport;
  typedTool: {
    // Absent exposes the whole MCP surface. A set is the capability-level
    // primitive that makes a read-only scope over a read+write server
    // enforceable, not just a prompt-level suggestion.
    actions?: string[] | null;
    // Applied after, and taking precedence over, the allowlist. The ergonomic
    // way to scope a read+write server read-only: deny the write tools instead
    // of enumerating every read tool.
    deniedActions?: string[] | null;
    // Fixed values the operator pinned on the binding. They apply to every tool
    // the MCP server exposes through it — the same reach `builtin` presets have
    // over every action a binding lists.
    presetParameters?: object | null;
    /** A `builtin` binding's per-action presets, over `presetParameters`. */
    presetParametersByAction?: object | null;
  };
  meter: ToolExecutionMeter;
  toolContext?: Record<string, string>;
  logToolCallingError: LogToolCallingError;
  /**
   * Called when the binding contributed no tool to the turn — the listing could
   * not be obtained, or it was obtained and left nothing to attach. Reporting,
   * not control: an unreachable server still yields an empty surface rather
   * than failing the turn, but a turn that ran without its tools must not be
   * indistinguishable from one that had none to begin with.
   */
  reportResolutionFailure?: (args: { reason: string }) => void;
  /** Withholds actions whose definition drifted from its pin; null: no pins. */
  definitions?: McpDefinitionGate | null;
}): Promise<Record<string, Tool>> => {
  const result: Record<string, Tool> = {};
  const isBound = buildActionFilter(args.typedTool);
  const { transport } = args;

  const listing = await fetchMcpToolListing({
    transport,
    logToolCallingError: args.logToolCallingError,
    reportResolutionFailure: args.reportResolutionFailure,
  });
  if (!listing) return result;

  const shared = {
    transport,
    meter: args.meter,
    toolContext: args.toolContext,
    logToolCallingError: args.logToolCallingError,
  };
  const proxy = findDeferredProxy(listing);
  const bound = await boundMcpTools({
    listing,
    typedTool: args.typedTool,
    transport,
  });
  const withheld =
    (await args.definitions?.checkListing(bound)) ?? new Set<string>();
  for (const mcpTool of bound) {
    if (withheld.has(mcpTool.name)) continue;
    result[mcpTool.name] = buildMcpToolEntry({
      ...shared,
      presetParameters: presetParametersForAction({
        presetParameters: args.typedTool.presetParameters,
        presetParametersByAction: args.typedTool.presetParametersByAction,
        action: mcpTool.name,
      }),
      mcpTool,
      ...(proxy
        ? proxyRole({
            proxy,
            listing,
            mcpTool,
            isBound,
            definitions: args.definitions,
          })
        : {}),
    });
  }

  // A readable listing that leaves nothing to attach is not a transport
  // failure, but the turn still runs without the tools the agent is configured
  // to have — the one outcome that must never be silent.
  if (Object.keys(result).length === 0) {
    args.reportResolutionFailure?.({
      reason: emptySurfaceReason({ listing, withheld }),
    });
  }

  return result;
};

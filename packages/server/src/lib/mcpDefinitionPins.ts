/**
 * `mcp.pin_definitions`: trust on first use for an `mcp` tool's action
 * definitions. The first listing an agent turn makes pins one digest per
 * action; afterwards an action whose definition differs from its pin, or that
 * has none, is withheld from the model and files one `mcp_definition_drift`.
 *
 * A deferred server's tools reach the model through `describe`, so each is
 * pinned the first time it is described instead.
 */
import createDebug from 'debug';

import { db } from '../db';
import { unavailableToolsNote } from './agentToolUnavailable';
import { fileException } from './exceptions';
import { loggableError } from './loggableError';
import type { McpToolListing } from './mcpToolListing';
import { isPlainObject } from './plainObject';
import { stableDigest } from './stableDigest';

const log = createDebug('soat:mcp-pins');

type Pins = Record<string, string>;

/** The fields the model reads, or gating may read; `_meta` is neither. */
export const mcpDefinitionDigest = (tool: McpToolListing): string => {
  return stableDigest({
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null,
    annotations: tool.annotations ?? null,
  });
};

const readPins = async (publicId: string): Promise<Pins | null> => {
  const row = await db.Tool.findOne({
    where: { publicId },
    attributes: ['mcpPins'],
  });
  return row?.mcpPins ?? null;
};

/**
 * Conditional writes, so concurrent first turns cannot overwrite each other:
 * a listing pins only a tool with no pins, a description only the names
 * without one. Either way the stored pins are read back and win.
 */
const writePins = async (args: {
  publicId: string;
  live: Pins;
  mode: 'listing' | 'described';
  current: Pins | null;
}): Promise<Pins | null> => {
  if (Object.keys(args.live).length === 0) return args.current;
  if (args.mode === 'listing') {
    if (args.current !== null) return args.current;
    await db.Tool.update(
      { mcpPins: args.live },
      { where: { publicId: args.publicId, mcpPins: null } }
    );
    return readPins(args.publicId);
  }
  const current = args.current;
  if (
    current !== null &&
    Object.keys(args.live).every((name) => {
      return name in current;
    })
  ) {
    return current;
  }
  await db.sequelize.query(
    `UPDATE tools
        SET mcp_pins = CAST(:live AS jsonb) || COALESCE(mcp_pins, CAST('{}' AS jsonb))
      WHERE public_id = :publicId`,
    {
      replacements: {
        live: JSON.stringify(args.live),
        publicId: args.publicId,
      },
    }
  );
  return readPins(args.publicId);
};

type PinnedTool = {
  publicId: string;
  projectId: number;
  name: string;
  mcp: unknown;
  mcpPins?: Pins | null;
};

const fileDrift = async (args: {
  tool: PinnedTool;
  action: string;
  pinned: string | null;
  live: string;
}): Promise<void> => {
  try {
    await fileException({
      projectId: args.tool.projectId,
      kind: 'mcp_definition_drift',
      title: `MCP tool ${args.tool.name}: action ${args.action} differs from its pinned definition`,
      detail: {
        toolId: args.tool.publicId,
        toolName: args.tool.name,
        action: args.action,
        pinnedDigest: args.pinned,
        liveDigest: args.live,
      },
      dedupKey: `mcp_definition_drift:${stableDigest([
        args.tool.publicId,
        args.action,
        args.pinned,
        args.live,
      ])}`,
    });
  } catch (error) {
    // Reporting must not take the turn down; the action is withheld regardless.
    log(
      'fileDrift: failed tool=%s error=%o',
      args.tool.publicId,
      loggableError(error)
    );
  }
};

export type McpDefinitionGate = {
  /** The listed actions this binding attaches; returns those withheld. */
  checkListing: (tools: McpToolListing[]) => Promise<Set<string>>;
  /** A deferred `describe` result, with withheld tools replaced by the note. */
  reviewDescribed: (result: unknown) => Promise<unknown>;
  /** The note a deferred `call` answers instead of reaching `name`, if any. */
  refuseCall: (name: string) => string | null;
};

/** `null` when the tool does not pin: an inline tool has no row to pin to. */
export const mcpDefinitionGate = (args: {
  tool: PinnedTool;
  /** Told each listed action withheld, so the turn's note names it. */
  onWithheld?: (args: { toolName: string }) => void;
}): McpDefinitionGate | null => {
  const { tool } = args;
  if (!isPlainObject(tool.mcp) || tool.mcp.pin_definitions !== true) {
    return null;
  }
  if (!tool.publicId) return null;

  let pins: Pins | null = tool.mcpPins ?? null;
  const withheld = new Set<string>();

  const check = async (checkArgs: {
    tools: McpToolListing[];
    mode: 'listing' | 'described';
  }): Promise<Set<string>> => {
    const live: Pins = Object.fromEntries(
      checkArgs.tools.map((listed) => {
        return [listed.name, mcpDefinitionDigest(listed)];
      })
    );
    pins = await writePins({
      publicId: tool.publicId,
      live,
      mode: checkArgs.mode,
      current: pins,
    });
    const drifted = new Set<string>();
    for (const [action, digest] of Object.entries(live)) {
      const pinned = pins?.[action] ?? null;
      if (pinned === digest) continue;
      drifted.add(action);
      withheld.add(action);
      await fileDrift({ tool, action, pinned, live: digest });
    }
    return drifted;
  };

  return {
    checkListing: async (tools) => {
      const drifted = await check({ tools, mode: 'listing' });
      for (const toolName of drifted) args.onWithheld?.({ toolName });
      return drifted;
    },
    reviewDescribed: async (result) => {
      const described = isPlainObject(result) ? result.tools : undefined;
      if (!isPlainObject(result) || !Array.isArray(described)) return result;
      const tools = described.filter((entry): entry is McpToolListing => {
        return isPlainObject(entry) && typeof entry.name === 'string';
      });
      const drifted = await check({ tools, mode: 'described' });
      if (drifted.size === 0) return result;
      return {
        ...result,
        tools: tools.filter((entry) => {
          return !drifted.has(entry.name);
        }),
        note: unavailableToolsNote([...drifted]),
      };
    },
    refuseCall: (name) => {
      return pins?.[name] !== undefined && !withheld.has(name)
        ? null
        : unavailableToolsNote([name]);
    },
  };
};

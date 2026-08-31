/**
 * Which of an agent's bound tools a generation may use, and how their persisted
 * ids map to the names the AI SDK is keyed by.
 *
 * Their own module rather than `agents.ts`: neither touches an agent row, and
 * reaching them there would make the generation modules import the CRUD module,
 * which is an import-cycle edge.
 */
import { db } from '../db';

/**
 * The bound tool ids a generation may resolve after applying the agent's
 * `active_tool_ids` restriction (`modules/agents.md` — Active Tools). Shared by
 * the generation and recovery paths so a resumed run is restricted identically.
 *
 * Fails open on absent/empty (agents stored `[]` while the field was inert
 * (#811), so honouring it would strip their tools on upgrade) and on a
 * non-array (the column is untyped JSON). Inline tool definitions carry no id,
 * so they can never be named here and stay active.
 */
export const narrowToActiveTools = (args: {
  toolIds: string[];
  activeToolIds: unknown;
}): string[] => {
  if (!Array.isArray(args.activeToolIds)) return args.toolIds;
  const allowed = new Set(
    args.activeToolIds.filter((id): id is string => {
      return typeof id === 'string';
    })
  );
  if (allowed.size === 0) return args.toolIds;
  return args.toolIds.filter((id) => {
    return allowed.has(id);
  });
};

/**
 * Resolves persisted tool ids to their names, for `step_rules[].active_tool_ids`
 * (`modules/agents.md` — Step Rules, #809). The AI SDK's `activeTools` option is
 * keyed by tool **name**, while the persisted rule holds tool **ids** — this is
 * the id→name map `buildPrepareStep` needs to translate one into the other.
 *
 * Unlike `assertActiveToolsExist` (`agents.ts`), this runs at generation time
 * rather than on write: an id naming no tool in the project (typo, wrong
 * project, a tool deleted after the rule was written) is silently dropped from
 * the map instead of rejected, so a step rule with mixed valid/stale ids still
 * restricts to the ids that resolve rather than failing the whole generation.
 */
export const resolveToolIdsToNames = async (args: {
  toolIds: string[];
  projectId: number;
}): Promise<Record<string, string>> => {
  if (args.toolIds.length === 0) return {};

  const found = await db.Tool.findAll({
    where: { publicId: args.toolIds, projectId: args.projectId },
    attributes: ['publicId', 'name'],
  });

  const map: Record<string, string> = {};
  for (const foundTool of found) {
    map[foundTool.publicId] = foundTool.name;
  }
  return map;
};

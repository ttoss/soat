/**
 * Which of an agent's bound tools a generation may use, and how their persisted
 * ids map to the names the AI SDK is keyed by.
 *
 * Both functions used to live in `agents.ts`, which meant the generation
 * modules had to import the CRUD module to reach them — three of the cluster's
 * import cycles ran through exactly that edge. Neither touches an agent row, so
 * neither belongs there.
 */
import { db } from '../db';

/**
 * The bound tool ids a generation may actually resolve, after applying the
 * agent's `active_tool_ids` restriction (`modules/agents.md` — Active Tools).
 *
 * Shared by the generation and recovery paths so a resumed run is restricted
 * exactly like the run it resumes.
 *
 * Two deliberate fail-open cases, both about not disarming a live agent for a
 * value that cannot express real intent:
 *
 * - **absent / empty** — an empty active set would leave the agent with no
 *   tools at all, which is never a deliberate configuration, and agents stored
 *   `[]` while this field was inert (#811), so honouring it literally would
 *   silently strip their tools on upgrade.
 * - **not an array** — the column is untyped JSON, so a legacy or hand-written
 *   row can hold anything.
 *
 * Inline (ephemeral) tool definitions carry no id, so they can never be named
 * here and are always left active; they are authored on the agent itself
 * alongside this field rather than referenced from the project.
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

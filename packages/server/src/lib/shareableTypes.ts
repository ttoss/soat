/**
 * The resource types a project may share with another, and what a share of
 * each may grant.
 *
 * One table, so the grantable set is deterministic: an action outside an
 * entry is refused at create, and a write action is never listed. Adding a
 * type is one entry here plus `countAcceptedShares` / `revokeResourceShares`
 * (`shareLifecycle.ts`) in its module's delete, never a new route.
 */
import { db } from '../db';
import type { ErrorCode } from '../errors';

/** The fields of a shared resource a grantee may see — never its internals. */
export type ShareProjection = Record<string, unknown>;

type ShareableType = {
  /** The module the resource belongs to, as its permission file names it. */
  module: string;
  /** The actions a share of this type may grant; reads and runs only. */
  actions: readonly string[];
  /** The `400` a missing resource answers at create. */
  notFoundCode: ErrorCode;
  /** Loads the resource in its own project, or `null` when it is gone. */
  findProjection: (args: {
    projectId: number;
    id: string;
  }) => Promise<ShareProjection | null>;
};

export const SHAREABLE_TYPES: Readonly<Record<string, ShareableType>> = {
  // Never `execute`, `auth`, headers or `output_mapping`: they carry the
  // publisher's endpoint and credentials.
  tool: {
    module: 'tools',
    actions: ['tools:CallTool'],
    notFoundCode: 'TOOL_NOT_FOUND',
    findProjection: async ({ projectId, id }) => {
      const tool = await db.Tool.findOne({
        where: { publicId: id, projectId },
        attributes: ['publicId', 'name', 'description', 'parameters'],
      });
      if (!tool) return null;
      return {
        id: tool.publicId,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      };
    },
  },
  // Never the instructions, provider or tools.
  agent: {
    module: 'agents',
    actions: ['agents:CreateAgentGeneration'],
    notFoundCode: 'AGENT_NOT_FOUND',
    findProjection: async ({ projectId, id }) => {
      const agent = await db.Agent.findOne({
        where: { publicId: id, projectId },
        attributes: ['publicId', 'name'],
      });
      if (!agent) return null;
      return { id: agent.publicId, name: agent.name };
    },
  },
};

export const findShareableType = (
  resourceType: string
): ShareableType | undefined => {
  return Object.hasOwn(SHAREABLE_TYPES, resourceType)
    ? SHAREABLE_TYPES[resourceType]
    : undefined;
};

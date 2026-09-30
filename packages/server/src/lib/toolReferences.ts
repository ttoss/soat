import { db } from '../db';
import { DomainError } from '../errors';

/**
 * Refuses tool ids that name no tool in `projectId`, the project of the row
 * that holds the reference. Never the caller's scope: a credential reaching
 * several projects must not let one project's row name another's tool.
 */
export const assertToolsInProject = async (args: {
  toolIds: string[];
  projectId: number;
}): Promise<void> => {
  if (args.toolIds.length === 0) return;

  const found = await db.Tool.findAll({
    where: { publicId: args.toolIds, projectId: args.projectId },
    attributes: ['publicId'],
  });
  const foundSet = new Set(
    found.map((tool) => {
      return tool.publicId;
    })
  );
  const missing = [...new Set(args.toolIds)].filter((id) => {
    return !foundSet.has(id);
  });
  if (missing.length > 0) {
    throw new DomainError(
      'TOOL_NOT_FOUND',
      `Tool(s) not found in the project: ${missing.join(', ')}.`,
      { missing }
    );
  }
};

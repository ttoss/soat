import createDebug from 'debug';

import { DomainError } from '../errors';
import { countBackendDeciders } from './deciderDependents';
import { tools } from './tools';

const log = createDebug('soat:tools');

export const deleteTool = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<void> => {
  log('deleteTool: id=%s', args.id);
  const tool = await tools.getByPublicId(args);
  // A decider's backend: the FK is RESTRICT, so this is the readable refusal.
  const deciderCount = await countBackendDeciders({
    backend: { toolId: tool.id as number },
    excludingPublicIds: new Set(),
  });
  if (deciderCount > 0) {
    throw new DomainError(
      'TOOL_HAS_DEPENDENTS',
      `Tool '${tool.publicId}' is the backend of ${deciderCount} decider(s).`,
      { decider_count: deciderCount }
    );
  }
  await tool.destroy();
};

/** Why {@link deleteTool} would refuse, or null; see `FormationModule.findDeletionBlocker`. */
export const findToolDeletionBlocker = async (args: {
  projectIds?: number[];
  id: string;
  /** Physical ids deleted alongside the tool; a decider among them blocks nothing. */
  alsoDeleting: ReadonlySet<string>;
}): Promise<string | null> => {
  log('findToolDeletionBlocker: id=%s', args.id);
  const tool = await tools.getByPublicId(args);
  const deciderCount = await countBackendDeciders({
    backend: { toolId: tool.id as number },
    excludingPublicIds: args.alsoDeleting,
  });
  if (deciderCount === 0) return null;
  return `Tool '${args.id}' is the backend of ${String(deciderCount)} decider(s), so it cannot be deleted.`;
};

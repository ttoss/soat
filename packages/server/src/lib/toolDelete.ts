import createDebug from 'debug';

import { DomainError } from '../errors';
import { countConverterRules } from './converterRuleDependents';
import { countBackendDeciders } from './deciderDependents';
import { countAcceptedShares, revokeResourceShares } from './shareLifecycle';
import { tools } from './tools';

const log = createDebug('soat:tools');

export const deleteTool = async (args: {
  projectIds?: number[];
  id: string;
  force?: boolean;
}): Promise<void> => {
  log('deleteTool: id=%s force=%s', args.id, Boolean(args.force));
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
  const shareRef = { resourceType: 'tool', resourceId: tool.publicId };
  const [acceptedShareCount, ingestionRuleCount] = await Promise.all([
    countAcceptedShares(shareRef),
    countConverterRules({
      converter: { toolId: tool.id as number },
      projectId: tool.projectId,
      excludingPublicIds: new Set(),
    }),
  ]);
  if ((acceptedShareCount > 0 || ingestionRuleCount > 0) && !args.force) {
    throw new DomainError(
      'TOOL_HAS_DEPENDENTS',
      `Tool '${tool.publicId}' is shared with ${acceptedShareCount} project(s) that accepted it and converts for ${ingestionRuleCount} ingestion rule(s); retry with force=true to revoke the shares and leave the rules without a converter.`,
      {
        accepted_share_count: acceptedShareCount,
        ingestion_rule_count: ingestionRuleCount,
      }
    );
  }
  await revokeResourceShares(shareRef);
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
  if (deciderCount > 0) {
    return `Tool '${args.id}' is the backend of ${String(deciderCount)} decider(s), so it cannot be deleted.`;
  }
  const [acceptedShareCount, ingestionRuleCount] = await Promise.all([
    countAcceptedShares({ resourceType: 'tool', resourceId: tool.publicId }),
    countConverterRules({
      converter: { toolId: tool.id as number },
      projectId: tool.projectId,
      excludingPublicIds: args.alsoDeleting,
    }),
  ]);
  if (acceptedShareCount === 0 && ingestionRuleCount === 0) return null;
  return `Tool '${args.id}' is shared with ${String(acceptedShareCount)} project(s) that accepted it and converts for ${String(ingestionRuleCount)} ingestion rule(s), so it cannot be deleted.`;
};

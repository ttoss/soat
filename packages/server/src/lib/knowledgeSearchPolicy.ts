import type { KnowledgePolicyWhere } from './knowledge';
import {
  compileAcrossPolicySets,
  type ScopePolicySet,
} from './scopePolicySets';

export type KnowledgeSearchPolicy =
  | { forbidden: true }
  | {
      forbidden: false;
      memoriesForbidden: boolean;
      policyWhere: KnowledgePolicyWhere;
    };

/**
 * Compiles `knowledge:SearchKnowledge` once per resource type the search
 * reads, over every policy set it spans. A statement reaches only the types
 * its SRN names, so each type answers access on its own: no access to
 * documents searches nothing, and no access to memories or their stores
 * leaves the memory half out.
 */
export const compileKnowledgeSearchPolicy = (args: {
  policySets: ScopePolicySet[];
}): KnowledgeSearchPolicy => {
  const compileFor = (compileArgs: {
    resourceType: string;
    columnRoot?: string;
  }) => {
    return compileAcrossPolicySets({
      policySets: args.policySets,
      action: 'knowledge:SearchKnowledge',
      resourceType: compileArgs.resourceType,
      columnRoot: compileArgs.columnRoot,
    });
  };

  const document = compileFor({
    resourceType: 'document',
    // The document half ranks `DocumentChunk` rows, so a document column is
    // reached through the `document` association rather than on the query root.
    columnRoot: 'document',
  });
  if (!document.hasAccess) return { forbidden: true };

  // The memory store half roots at `Memory` with `MemoryStore` joined, and each
  // clause is applied to the model whose columns it names — no root rewrite.
  const memoryStore = compileFor({ resourceType: 'memory_store' });
  const memory = compileFor({ resourceType: 'memory' });

  return {
    forbidden: false,
    memoriesForbidden: !memoryStore.hasAccess || !memory.hasAccess,
    policyWhere: {
      document: document.where,
      memoryStore: memoryStore.where,
      memory: memory.where,
    },
  };
};

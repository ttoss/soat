import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { hasPolicyConstraints, referencesAssociation } from './policyWhere';
import { projectScopeWhere } from './projectScope';
import {
  compileAcrossPolicySets,
  type ScopePolicySet,
} from './scopePolicySets';
import { liveDocumentWhere } from './systemPathScope';

/**
 * The stored vector a "more like this" search ranks by, and the rows it must
 * leave out. A source is readable when `knowledge:SearchKnowledge` reaches it,
 * so a search can never probe with a row it could not have returned.
 */

export type SimilaritySourceRef =
  | { documentId: string; memoryId?: undefined }
  | { memoryId: string; documentId?: undefined };

export type SimilaritySource = {
  embedding: number[];
  excludeDocumentIds?: string[];
  excludeMemoryIds?: string[];
};

const log = createDebug('soat:knowledgeSimilaritySource');

const ACTION = 'knowledge:SearchKnowledge';

const notFound = (): DomainError => {
  return new DomainError('RESOURCE_NOT_FOUND', 'Similarity source not found');
};

const notEmbedded = (): DomainError => {
  return new DomainError(
    'SIMILARITY_SOURCE_NOT_EMBEDDED',
    'The similarity source has no embedding yet'
  );
};

/** pgvector columns read back as `number[]` or as their `[a,b,…]` text form. */
const readVector = (value: unknown): number[] | null => {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'string' && value.startsWith('[')) {
    return value.slice(1, -1).split(',').map(Number);
  }
  return null;
};

/** A multi-chunk document points where its chunks point on average. */
const meanVector = (vectors: number[][]): number[] => {
  const sum = new Array<number>(vectors[0].length).fill(0);
  for (const vector of vectors) {
    for (const [index, value] of vector.entries()) sum[index] += value;
  }
  return sum.map((value) => {
    return value / vectors.length;
  });
};

const compileWhere = (args: {
  policySets: ScopePolicySet[];
  resourceType: string;
}): Record<string, unknown> | null => {
  const compiled = compileAcrossPolicySets({
    policySets: args.policySets,
    action: ACTION,
    resourceType: args.resourceType,
  });
  if (!compiled.hasAccess) return null;
  return hasPolicyConstraints(compiled.where) ? compiled.where : {};
};

const resolveDocumentSource = async (args: {
  documentId: string;
  projectIds?: number[];
  policySets: ScopePolicySet[];
}): Promise<SimilaritySource> => {
  const policyWhere = compileWhere({
    policySets: args.policySets,
    resourceType: 'document',
  });
  if (!policyWhere) throw notFound();

  const fileWhere = projectScopeWhere({ projectIds: args.projectIds });
  const document = await db.Document.findOne({
    where: {
      [Op.and]: [
        policyWhere,
        liveDocumentWhere(),
        { publicId: args.documentId },
      ],
    },
    include: [
      {
        model: db.File,
        as: 'file',
        where: Reflect.ownKeys(fileWhere).length > 0 ? fileWhere : undefined,
        include: [{ model: db.Project, as: 'project' }],
      },
    ],
    subQuery: referencesAssociation(policyWhere) ? false : undefined,
  });
  if (!document) throw notFound();

  const chunks = await db.DocumentChunk.findAll({
    where: { documentId: document.id, embedding: { [Op.ne]: null } },
    attributes: ['embedding'],
  });
  const vectors = chunks
    .map((chunk) => {
      return readVector(chunk.getDataValue('embedding'));
    })
    .filter((vector): vector is number[] => {
      return vector !== null;
    });
  if (vectors.length === 0) throw notEmbedded();

  return {
    embedding: meanVector(vectors),
    excludeDocumentIds: [args.documentId],
  };
};

const resolveMemorySource = async (args: {
  memoryId: string;
  projectIds?: number[];
  policySets: ScopePolicySet[];
}): Promise<SimilaritySource> => {
  const memoryWhere = compileWhere({
    policySets: args.policySets,
    resourceType: 'memory',
  });
  const memoryStoreWhere = compileWhere({
    policySets: args.policySets,
    resourceType: 'memory_store',
  });
  if (!memoryWhere || !memoryStoreWhere) throw notFound();

  const memory = await db.Memory.findOne({
    where: { [Op.and]: [memoryWhere, { publicId: args.memoryId }] },
    include: [
      {
        model: db.MemoryStore,
        as: 'memoryStore',
        where: {
          ...projectScopeWhere({ projectIds: args.projectIds }),
          ...memoryStoreWhere,
        },
        required: true,
      },
      { model: db.MemoryContent, as: 'content', required: true },
    ],
    subQuery: false,
  });
  if (!memory) throw notFound();

  const content = memory.get('content') as InstanceType<
    (typeof db)['MemoryContent']
  >;
  const embedding = readVector(content.getDataValue('embedding'));
  if (!embedding) throw notEmbedded();

  return { embedding, excludeMemoryIds: [args.memoryId] };
};

/**
 * Unknown and unreadable answer the same `404`, so a probe never discloses
 * that a hidden id exists.
 */
export const resolveSimilaritySource = async (args: {
  source: SimilaritySourceRef;
  projectIds?: number[];
  policySets: ScopePolicySet[];
}): Promise<SimilaritySource> => {
  log(
    'resolveSimilaritySource: documentId=%s memoryId=%s',
    args.source.documentId,
    args.source.memoryId
  );
  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    throw notFound();
  }
  return args.source.documentId !== undefined
    ? resolveDocumentSource({
        documentId: args.source.documentId,
        projectIds: args.projectIds,
        policySets: args.policySets,
      })
    : resolveMemorySource({
        memoryId: args.source.memoryId,
        projectIds: args.projectIds,
        policySets: args.policySets,
      });
};

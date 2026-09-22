import {
  DOCUMENT_RELATION_TYPES,
  type DocumentRelationType,
} from '@soat/postgresdb';
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';

const log = createDebug('soat:documents');

type RelationRow = {
  publicId: string;
  type: DocumentRelationType;
  fromDocument?: { publicId: string } | null;
  toDocument?: { publicId: string } | null;
  createdAt: Date;
};

const relationIncludes = () => {
  return [
    { model: db.Document, as: 'fromDocument' },
    { model: db.Document, as: 'toDocument' },
  ];
};

const mapRelation = (relation: RelationRow) => {
  return {
    id: relation.publicId,
    type: relation.type,
    from_document_id: relation.fromDocument?.publicId,
    to_document_id: relation.toDocument?.publicId,
    created_at: relation.createdAt,
  };
};

/**
 * Reads a declared relation type off a request body. An undeclared kind is a
 * client error rather than a stored string: the set exists so a consumer can
 * act on an edge without interpreting it, and a `inspired_by` nobody handles
 * is an edge that silently does nothing.
 */
export const readRelationType = (value: unknown): DocumentRelationType => {
  if (
    typeof value !== 'string' ||
    !(DOCUMENT_RELATION_TYPES as readonly string[]).includes(value)
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `type must be one of: ${DOCUMENT_RELATION_TYPES.join(', ')}`,
      { type: value }
    );
  }
  return value as DocumentRelationType;
};

/**
 * The document row a caller may act on, by public id. `projectIds` is the
 * caller's scope: a document outside it is reported missing rather than
 * refused, so an id in another project cannot be probed for existence.
 */
const requireDocumentRow = async (args: {
  publicId: string;
  projectIds?: number[];
}) => {
  const document = await db.Document.findOne({
    where: { publicId: args.publicId },
    include: [{ model: db.File, as: 'file' }],
  });

  const projectId = document?.file?.projectId;
  const inScope =
    args.projectIds === undefined ||
    (projectId !== undefined && args.projectIds.includes(projectId));

  if (!document || !inScope) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Document not found');
  }

  return document;
};

/**
 * Asserts an edge from one document to another.
 *
 * Both ends are resolved in the caller's scope, so an edge cannot be drawn to
 * a document the caller cannot read — the relation would otherwise answer
 * "does `doc_…` exist" for every id in the deployment.
 */
export const createDocumentRelation = async (args: {
  fromDocumentId: string;
  type: DocumentRelationType;
  toDocumentId: string;
  projectIds?: number[];
}) => {
  log(
    'createDocumentRelation: from=%s type=%s to=%s',
    args.fromDocumentId,
    args.type,
    args.toDocumentId
  );

  if (args.fromDocumentId === args.toDocumentId) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'a document cannot relate to itself'
    );
  }

  const from = await requireDocumentRow({
    publicId: args.fromDocumentId,
    projectIds: args.projectIds,
  });
  const to = await requireDocumentRow({
    publicId: args.toDocumentId,
    projectIds: args.projectIds,
  });

  // One project per edge. A relation is read back through project-scoped
  // surfaces — the listing filter, the export — so an edge leaving the project
  // would be visible from one end and invisible from the other.
  if (from.file?.projectId !== to.file?.projectId) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'both documents must be in the same project'
    );
  }

  const [relation, created] = await db.DocumentRelation.findOrCreate({
    where: {
      fromDocumentId: from.id as number,
      type: args.type,
      toDocumentId: to.id as number,
    },
    defaults: {
      fromDocumentId: from.id as number,
      type: args.type,
      toDocumentId: to.id as number,
    },
  });

  if (!created) {
    throw new DomainError(
      'DOCUMENT_RELATION_EXISTS',
      'that relation is already asserted',
      { id: relation.publicId }
    );
  }

  log('createDocumentRelation: created id=%s', relation.publicId);

  return mapRelation({
    publicId: relation.publicId,
    type: relation.type,
    fromDocument: { publicId: from.publicId },
    toDocument: { publicId: to.publicId },
    createdAt: relation.createdAt,
  });
};

/** The edges a document asserts, oldest first. */
export const listDocumentRelations = async (args: {
  documentId: string;
  projectIds?: number[];
}) => {
  const document = await requireDocumentRow({
    publicId: args.documentId,
    projectIds: args.projectIds,
  });

  const relations = await db.DocumentRelation.findAll({
    where: { fromDocumentId: document.id as number },
    include: relationIncludes(),
    order: [['createdAt', 'ASC']],
  });

  return { data: relations.map(mapRelation) };
};

/**
 * The edges a document asserts, for a read of that document. Scoping is the
 * read's own: the caller has already been authorized for the document whose
 * edges these are.
 */
export const relationsForDocument = async (args: { documentId: string }) => {
  const relations = await db.DocumentRelation.findAll({
    where: { '$fromDocument.public_id$': args.documentId },
    include: relationIncludes(),
    order: [['createdAt', 'ASC']],
  });

  return relations.map(mapRelation);
};

/** Retracts an edge. The documents at both ends are left alone. */
export const deleteDocumentRelation = async (args: {
  documentId: string;
  relationId: string;
  projectIds?: number[];
}): Promise<void> => {
  log(
    'deleteDocumentRelation: document=%s relation=%s',
    args.documentId,
    args.relationId
  );

  const document = await requireDocumentRow({
    publicId: args.documentId,
    projectIds: args.projectIds,
  });

  const relation = await db.DocumentRelation.findOne({
    where: {
      publicId: args.relationId,
      fromDocumentId: document.id as number,
    },
  });

  if (!relation) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Relation not found');
  }

  await relation.destroy();
};

/**
 * The row ids of a document's neighbours, on either side of the edge.
 *
 * Either side because an edge is asserted by one document about another: a
 * reader of the cited report would otherwise have no way to find what cites
 * it, which is half of what a relation is for.
 */
export const relatedDocumentRowIds = async (args: {
  documentId: string;
  projectIds?: number[];
}): Promise<number[]> => {
  const document = await requireDocumentRow({
    publicId: args.documentId,
    projectIds: args.projectIds,
  });

  const rowId = document.id as number;

  const relations = await db.DocumentRelation.findAll({
    where: {
      [Op.or]: [{ fromDocumentId: rowId }, { toDocumentId: rowId }],
    },
  });

  const neighbours = relations.map((relation) => {
    return relation.fromDocumentId === rowId
      ? relation.toDocumentId
      : relation.fromDocumentId;
  });

  return [...new Set(neighbours)];
};

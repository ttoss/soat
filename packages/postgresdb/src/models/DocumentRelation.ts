import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Document } from './Document';

/**
 * What one document asserts about another: this report is derived from that
 * one, supersedes it, or cites it.
 *
 * The kinds are a declared set rather than free text. A corpus many agents
 * write into is read by consumers that have to act on an edge, and
 * `derived-from`, `derivedFrom` and `derived from` are three edges to a reader
 * and one to the writer who typed them.
 *
 * The edge is directed and owned by the document it leaves, which is what
 * makes a relation assertable without touching the document it points at: an
 * agent filing a report may say what it derives from, and cannot make another
 * report claim anything about itself.
 */
export const DOCUMENT_RELATION_TYPES = [
  'derived_from',
  'supersedes',
  'cites',
] as const;

export type DocumentRelationType = (typeof DOCUMENT_RELATION_TYPES)[number];

@Table({
  tableName: 'document_relations',
  indexes: [
    {
      name: 'document_relations_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    // One row per assertion: re-asserting the same edge is the same fact, and
    // a second row would make "how many times does A cite B" a question with
    // an answer.
    {
      name: 'document_relations_edge_unique',
      unique: true,
      fields: ['from_document_id', 'type', 'to_document_id'],
    },
    // The reverse lookup `?related_to=` needs: the forward direction is served
    // by the unique index above.
    {
      name: 'document_relations_to_document_id_idx',
      fields: ['to_document_id'],
    },
  ],
  updatedAt: false,
  hooks: {
    beforeValidate: (instance: DocumentRelation) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.documentRelation
        );
      }
    },
  },
})
export class DocumentRelation extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Document;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare fromDocumentId: number;

  /**
   * Both ends cascade: an edge is a claim about two documents that exist, so
   * deleting either leaves nothing to assert. A `RESTRICT` here would make a
   * document undeletable because something else cited it.
   */
  @BelongsTo(
    () => {
      return Document;
    },
    { foreignKey: 'fromDocumentId', onDelete: 'CASCADE' }
  )
  declare fromDocument: Document;

  @Column({
    type: DataType.ENUM(...DOCUMENT_RELATION_TYPES),
    allowNull: false,
  })
  declare type: DocumentRelationType;

  @ForeignKey(() => {
    return Document;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare toDocumentId: number;

  @BelongsTo(
    () => {
      return Document;
    },
    { foreignKey: 'toDocumentId', onDelete: 'CASCADE' }
  )
  declare toDocument: Document;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}

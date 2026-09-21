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
import { User } from './User';

/**
 * Immutable archive of a document's content and annotations at a given
 * version. A new row is written by the shared lib write path on every write
 * that actually changes them; existing rows are never mutated, so a run that
 * cited a version can still read what it read. A restore appends a new version
 * rather than rewinding the counter, so there is no `updatedAt`.
 *
 * Shares its column layout — and the lib engine that reads and writes it — with
 * `AgentVersion` (`src/lib/resourceVersions.ts`). The table stays separate so
 * the foreign key to `documents` is a real one.
 */
@Table({
  tableName: 'document_versions',
  indexes: [
    {
      name: 'document_versions_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    // Serves the point lookup and the newest-first listing, so no separate
    // index on `created_at` is needed.
    {
      name: 'document_versions_document_id_version_unique',
      unique: true,
      fields: ['document_id', 'version'],
    },
  ],
  updatedAt: false,
  hooks: {
    beforeValidate: (instance: DocumentVersion) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.documentVersion
        );
      }
    },
  },
})
export class DocumentVersion extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Document;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare documentId: number;

  @BelongsTo(() => {
    return Document;
  })
  declare document: Document;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare version: number;

  /**
   * The document's versioned surface, in the wire (snake_case) shape the
   * documents OpenAPI spec documents: `content`, `title`, `path`, `metadata`,
   * `tags` and the chunk configuration.
   *
   * A full snapshot rather than a diff. What a restore has to reproduce is
   * what a run read, which is a read *by version*; a diff chain would have to
   * be replayed to answer that, and a replay is only as trustworthy as the
   * pipeline that produced the deltas.
   *
   * A withdrawal is a version too, carrying no content — which is what makes
   * withdrawal and restore one mechanism rather than a second lifecycle
   * column for every reader to remember.
   */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare config: object;

  /** Optional human tag for this version, e.g. `pre-correction`. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare label: string | null;

  /**
   * The user whose action produced this version. Null for writes with no
   * request user behind them.
   */
  @ForeignKey(() => {
    return User;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare createdByUserId: number | null;

  @BelongsTo(() => {
    return User;
  })
  declare createdBy: User | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}

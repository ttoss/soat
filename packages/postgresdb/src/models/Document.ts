import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { File } from './File';

@Table({
  tableName: 'documents',
  indexes: [
    {
      name: 'documents_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      // Containment (`@>`) is the only way a tag bag is matched, by the
      // `?tags=` filter, knowledge search and a `soat:ResourceTag/<key>`
      // condition alike. `jsonb_path_ops` indexes whole key/value paths,
      // which is exactly what that match asks about.
      name: 'documents_tags_gin_idx',
      using: 'gin',
      fields: [{ name: 'tags', operator: 'jsonb_path_ops' }],
    },
    {
      name: 'documents_file_id_unique',
      unique: true,
      fields: ['file_id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: Document) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.document);
      }
    },
  },
})
export class Document extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return File;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare fileId: number;

  @BelongsTo(
    () => {
      return File;
    },
    { onDelete: 'RESTRICT' }
  )
  declare file: File;

  @Column({
    type: DataType.STRING,
    allowNull: true,
  })
  declare title: string | null;

  /**
   * Caller-owned annotations, opaque to the platform: nothing the server owns
   * is stored here, and no key of it is read.
   *
   * JSONB rather than serialized text so a filter can reach inside it — a
   * stringified bag can only be matched as a whole string, which is not a
   * filter over the fields it holds.
   */
  @Column({
    type: DataType.JSONB,
    allowNull: true,
  })
  declare metadata: Record<string, unknown> | null;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
  })
  declare tags: Record<string, string> | null;

  /**
   * The chunking configuration the document was last (re-)ingested with.
   * Persisted so a formation `document` resource can read its chunk settings
   * back and a re-plan of the same template converges to a no-op instead of
   * perpetually re-reporting these fields as changed. `null` means the default
   * (`whole`) strategy / library defaults were used.
   */
  @Column({
    type: DataType.STRING(16),
    allowNull: true,
  })
  declare chunkStrategy: 'page' | 'whole' | 'size' | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
  })
  declare chunkSize: number | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
  })
  declare chunkOverlap: number | null;

  /**
   * `withdrawn` is not a fifth ingestion state but the projection of one: it
   * says the document's current version is a tombstone, so that "is this
   * document live" is one indexed predicate rather than a correlated lookup
   * into `document_versions` on every listing row and every knowledge hit.
   *
   * The version is still the record — it is what a restore reads and what says
   * when and by whom — and `documentWithdrawal.ts` is the only writer of this
   * value, so the two cannot disagree.
   */
  @Column({
    type: DataType.STRING(16),
    allowNull: false,
    defaultValue: 'ready',
  })
  declare status: 'pending' | 'processing' | 'ready' | 'failed' | 'withdrawn';

  /**
   * The document's content version, starting at 1. Every write that changes
   * the content or its annotations archives a `DocumentVersion` and bumps it.
   */
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 1,
  })
  declare version: number;

  /**
   * Set while `status = 'processing'` and a converter has deferred with
   * `{ status: "pending" }`. Cleared (to `null`) by whichever of the
   * ingestion-callback handler or the stall-timeout sweeper wins the atomic
   * compare-and-set race to finish the conversion — see documentIngestion.ts.
   */
  @Column({
    type: DataType.STRING(32),
    allowNull: true,
  })
  declare conversionAttemptId: string | null;

  /**
   * Destination path to apply to the backing File once ingestion completes.
   * Computed at enqueue time and must survive the async-converter round trip
   * (submitted here, read back by the ingestion callback), so it cannot live
   * in `metadata` — that bag is caller-owned and callers may overwrite it
   * mid-ingestion via `PATCH /documents/:id`.
   */
  @Column({
    type: DataType.STRING,
    allowNull: true,
    field: 'pending_doc_path',
  })
  declare pendingDocPath: string | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'total_pages',
  })
  declare totalPages: number | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'total_chunks',
  })
  declare totalChunks: number | null;

  /**
   * Live progress counter, rewritten periodically during chunk persistence
   * purely to bump `updatedAt` so a long-running ingestion doesn't look
   * stalled (see `isIngestionStale`). Not read back anywhere else.
   */
  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'indexed_chunks',
  })
  declare indexedChunks: number | null;

  @Column({
    type: DataType.STRING,
    allowNull: true,
    field: 'failure_reason',
  })
  declare failureReason: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}

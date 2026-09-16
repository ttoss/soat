import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Generation } from './Generation';
import { Memory } from './Memory';
import { MemoryContent } from './MemoryContent';
import { MemoryStore } from './MemoryStore';

/**
 * Through which door the write came. A *how*, never a *who* — the who is
 * `principalType`/`principalId`, and on both agent doors that is the agent.
 *
 * `rule` names the post-turn pass over a finished turn. It is deliberately not
 * `extraction`: today that pass is the built-in extractor configured on the
 * agent, and #1324 turns it into a `memory_rules` row with a pluggable handler.
 * Naming the value after the current implementation would schedule its own
 * rename — the `source_type: orchestration` pattern this design exists to stop.
 */
export const MEMORY_ASSERTION_MECHANISMS = [
  'tool',
  'rule',
  'api',
  'formation',
] as const;
export type MemoryAssertionMechanism =
  (typeof MEMORY_ASSERTION_MECHANISMS)[number];

export const MEMORY_ASSERTION_OUTCOMES = [
  'created',
  'superseded',
  'skipped',
] as const;
export type MemoryAssertionOutcome = (typeof MEMORY_ASSERTION_OUTCOMES)[number];

/**
 * Append-only, one row per write attempt — including the attempts that change
 * nothing, which is the half no column on `memories` could ever record.
 *
 * A memory row is *state*; an assertion is the *event* that resolved into it.
 * Foreign keys here are `SET NULL` rather than the loose pointer
 * `Memory.sourceId` chose: an assertion is an audit record, and the retention
 * sweep redacts a generation's content while keeping its row, so the link does
 * not dangle on the case it exists for.
 */
@Table({
  tableName: 'memory_assertions',
  indexes: [
    {
      name: 'memory_assertions_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      // Backs the store-wide volume query, which is always time-ordered.
      name: 'memory_assertions_memory_store_id_created_at_idx',
      fields: ['memory_store_id', 'created_at'],
    },
    {
      name: 'memory_assertions_memory_id_idx',
      fields: ['memory_id'],
    },
    {
      name: 'memory_assertions_generation_id_idx',
      fields: ['generation_id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: MemoryAssertion) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.memoryAssertion
        );
      }
    },
  },
})
export class MemoryAssertion extends Model {
  @Column({ type: DataType.STRING(32), allowNull: false })
  declare publicId: string;

  @ForeignKey(() => {
    return MemoryStore;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare memoryStoreId: number;

  @BelongsTo(
    () => {
      return MemoryStore;
    },
    { onDelete: 'CASCADE' }
  )
  declare memoryStore: MemoryStore;

  /** The text as asserted, which is not necessarily the memory's text. */
  @ForeignKey(() => {
    return MemoryContent;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare contentId: number;

  @BelongsTo(
    () => {
      return MemoryContent;
    },
    { onDelete: 'CASCADE' }
  )
  declare content: MemoryContent;

  /**
   * `created` and `superseded` name the new memory; `skipped` names the
   * existing memory that matched. Null only after that memory is deleted.
   *
   * The memory a `superseded` assertion retired is deliberately not a column:
   * it is `memories WHERE superseded_by_memory_id = assertion.memory_id`, and
   * that reverse join is unique because the algorithm supersedes exactly the
   * top match, one memory per assertion.
   */
  @ForeignKey(() => {
    return Memory;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare memoryId: number | null;

  @BelongsTo(
    () => {
      return Memory;
    },
    { foreignKey: 'memoryId', as: 'memory', onDelete: 'SET NULL' }
  )
  declare memory: Memory | null;

  /**
   * The origin of anything agent-written: the only entity both always present
   * and created by the event itself. Null on the `api` and `formation` doors.
   * The extractor does not change this — it is a tool-less completion that
   * creates no generation of its own, so it records the turn's generation.
   */
  @ForeignKey(() => {
    return Generation;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare generationId: number | null;

  @BelongsTo(
    () => {
      return Generation;
    },
    { onDelete: 'SET NULL' }
  )
  declare generation: Generation | null;

  @Column({ type: DataType.STRING(16), allowNull: false })
  declare mechanism: MemoryAssertionMechanism;

  /**
   * Set only when `mechanism` is `rule`. **Null means the built-in extractor**
   * driven by `knowledge_config.extraction`, until #1324 gives it a row in a
   * `memory_rules` table that does not exist yet — which is why this is a plain
   * nullable integer rather than a foreign key. #1324 adds the constraint and
   * starts populating the column; it renames nothing here.
   */
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare ruleId: number | null;

  /** The `Generation.startedByPrincipalType` vocabulary, plus `agent`. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare principalType: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare principalId: string;

  @Column({ type: DataType.STRING(16), allowNull: false })
  declare outcome: MemoryAssertionOutcome;

  /** The top match's cosine similarity — what decided the outcome. */
  @Column({ type: DataType.FLOAT, allowNull: true })
  declare similarity: number | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}

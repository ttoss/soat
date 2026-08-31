import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Project } from './Project';

/**
 * A continuation chain as a first-class row: the population of generations that
 * descend from one root through `initiator_generation_id` declarations.
 *
 * Before this the chain existed only as a value repeated on its members
 * (`generations.root_generation_id`), so the only way to ask "how large is this
 * chain, is it still running, and did it end because it was refused?" was a
 * `COUNT` plus inference from stop reasons. #1161 ran for 17 days precisely
 * because nothing named the runaway as one thing.
 *
 * `status` is **observability, not a gate**: enforcement still counts member
 * rows by `root_generation_id`, which is the value this table is keyed on rather
 * than a number this row could drift away from. Every write here is
 * best-effort — a chain row that fails to update must never fail the generation
 * that was trying to update it.
 */
@Table({
  tableName: 'generation_chains',
  indexes: [
    {
      name: 'generation_chains_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    // One row per chain. The chain is created lazily by the first continuation,
    // and two concurrent hops on the same root race to create it, so the
    // constraint — not the read before the write — is what keeps it single.
    {
      name: 'generation_chains_root_generation_id_unique',
      unique: true,
      fields: ['root_generation_id'],
    },
    {
      name: 'generation_chains_project_id_status_last_generation_at_idx',
      fields: ['project_id', 'status', 'last_generation_at'],
    },
  ],
  hooks: {
    beforeValidate: (instance: GenerationChain) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.generationChain
        );
      }
    },
  },
})
export class GenerationChain extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare projectId: number;

  @BelongsTo(() => {
    return Project;
  })
  declare project: Project;

  /**
   * Public id of the agent whose continuation opened the chain. Deliberately
   * **not** a foreign key, for the same reason as
   * `Generation.rootGenerationId`: the chain is the record of a runaway, and
   * `deleteAgent`'s cleanup must not be able to rewrite or remove it (#1161).
   * A chain can also span agents, so this names the one that opened it, not an
   * owner.
   */
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare agentId: string | null;

  /**
   * The generation the chain is rooted at — the chain's natural key, and the
   * same value its members carry in `generations.root_generation_id`. A plain
   * string for the reason above.
   */
  @Column({ type: DataType.STRING(32), allowNull: false })
  declare rootGenerationId: string;

  /**
   * `active` while hops are still being spawned; `concluded` when a member
   * finished on its own with nothing left pending; `expired` when a held
   * approval lapsed and the agent does not react to expiry (`on_approval_expiry`
   * = `terminate`), which is the chain's terminal case rather than a hop's;
   * `budget_exhausted` when the guard refused a hop.
   */
  @Column({
    type: DataType.ENUM('active', 'concluded', 'expired', 'budget_exhausted'),
    allowNull: false,
    defaultValue: 'active',
  })
  declare status: 'active' | 'concluded' | 'expired' | 'budget_exhausted';

  /**
   * Generations in the chain, re-derived from the authoritative `COUNT` on every
   * hop rather than incremented, so a write this table loses cannot leave the
   * number permanently wrong.
   */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare generationCount: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastGenerationAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}

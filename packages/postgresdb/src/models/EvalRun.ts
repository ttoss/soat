import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Eval } from './Eval';

/**
 * One execution of an {@link Eval} over its dataset.
 *
 * `agentVersion` is resolved **once**, at run start, and every item runs
 * against it. Without that pin, release assignment would bucket each item
 * independently (an eval generation has no session, so its assignment key is
 * null and each generation lands randomly), blending two configs into one score
 * — see the evaluations module doc, Version pinning.
 *
 * Never mutated after it reaches a terminal status, so there is no `updatedAt`;
 * `startedAt` / `finishedAt` carry the timeline.
 */
@Table({
  tableName: 'eval_runs',
  indexes: [
    {
      name: 'eval_runs_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'eval_runs_eval_id_created_at_idx',
      fields: ['eval_id', 'created_at'],
    },
    // The claims read picks a version's newest run per eval.
    {
      name: 'eval_runs_agent_public_id_agent_version_idx',
      fields: ['agent_public_id', 'agent_version'],
    },
  ],
  updatedAt: false,
  hooks: {
    beforeValidate: (instance: EvalRun) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.evalRun);
      }
    },
  },
})
export class EvalRun extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Eval;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare evalId: number;

  @BelongsTo(
    () => {
      return Eval;
    },
    { onDelete: 'CASCADE' }
  )
  declare eval: Eval;

  /**
   * Public id of the agent every item executes against, resolved at run
   * start. A string rather than an FK so it survives the agent's deletion and
   * the Eval being pointed elsewhere. Null on a run that recorded none, which
   * satisfies no promotion gate.
   */
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare agentPublicId: string | null;

  /** The one agent version every item in this run executed against. */
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare agentVersion: number;

  /**
   * The Eval's `scorers`, `pass_threshold` and `group_by` as they were when
   * the run was created: every item is scored and the run settled by these,
   * never by the Eval's current values. Null when not recorded.
   */
  @Column({ type: DataType.JSON, allowNull: true, defaultValue: null })
  declare definition: Record<string, unknown> | null;

  /**
   * The Eval's `claim` as it was when the run was created: what this run
   * tested, never the Eval's current wording. Null when the Eval stated none.
   */
  @Column({ type: DataType.JSON, allowNull: true, defaultValue: null })
  declare claim: Record<string, unknown> | null;

  /**
   * The decider version each `decider` scorer grades under, keyed by scorer
   * name and resolved at run start for the same reason as `agentVersion`.
   * Null when the eval has no decider scorer.
   */
  @Column({ type: DataType.JSON, allowNull: true, defaultValue: null })
  declare deciderVersions: Record<string, number> | null;

  /**
   * The model each model-backed scorer grades under, keyed by scorer name and
   * resolved at run start. Null when the eval has no model-backed scorer.
   */
  @Column({ type: DataType.JSON, allowNull: true, defaultValue: null })
  declare scorerModels: Record<string, Record<string, string>> | null;

  /** `queued` | `running` | `completed` | `failed` | `cancelled`. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare status: string;

  /** A terminal run of the same Eval to compute deltas against (Phase 2). */
  @ForeignKey(() => {
    return EvalRun;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare baselineRunId: number | null;

  @BelongsTo(
    () => {
      return EvalRun;
    },
    { onDelete: 'SET NULL' }
  )
  declare baselineRun: EvalRun | null;

  /** Per-scorer mean and pass rate; null until the run is terminal. */
  @Column({ type: DataType.JSON, allowNull: true })
  declare aggregateScores: object | null;

  /** `supported` | `refuted` | `insufficient`; null without a threshold. */
  @Column({ type: DataType.STRING(16), allowNull: true, defaultValue: null })
  declare verdict: string | null;

  /** Why the run settled on `verdict`, one entry per judged scope. */
  @Column({ type: DataType.JSON, allowNull: true, defaultValue: null })
  declare verdictReasons: unknown[] | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare itemCount: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare completedCount: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare erroredCount: number;

  /** Why a `failed` run failed, `{ code, message, meta? }`; null otherwise. */
  @Column({ type: DataType.JSON, allowNull: true, defaultValue: null })
  declare error: Record<string, unknown> | null;

  /**
   * Public id of the trigger that started this run, when a trigger did
   * (the evaluations module doc — a nightly schedule pointed at an Eval).
   * Denormalized rather than an FK, exactly like `OrchestrationRun.triggerId`,
   * so the origin survives the trigger being deleted: a run is a historical
   * measurement and its provenance must not be rewritten by a later edit. Null
   * for runs started directly through the API.
   */
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare triggerId: string | null;

  /**
   * Caller-owned key/value annotations supplied when the run was started, for
   * attributing a measurement to whatever the caller's own system knows about
   * it — the commit or PR being scored, the release candidate, the CI job.
   * Round-trips verbatim; the platform reads nothing from it.
   *
   * Every other field on the start request is platform-owned
   * (`agent_version`, `baseline_run_id`, `wait`), so without this column a CI
   * caller has nowhere to record what a run is measuring.
   */
  @Column({ type: DataType.JSON, allowNull: true, defaultValue: null })
  declare metadata: Record<string, unknown> | null;

  /**
   * The `tool_context` the run's item generations carry, so an agent whose
   * tools authorize through it is scored against the configuration it actually
   * runs in production.
   *
   * On the row rather than the starting request because a run outlives its
   * request: `wait: false` is the default and a trigger-fired run is always
   * background, so the worker driving the items re-reads it here.
   *
   * **Write-only**, unlike `metadata`: a run is a report other people read, and
   * a credential in it is not theirs to see. Cleared on reaching a terminal
   * state — a finished run outlives the work by a long way and nothing reads
   * the bag once the last item has run.
   */
  @Column({ type: DataType.JSON, allowNull: true, defaultValue: null })
  declare toolContext: Record<string, string> | null;

  // The authority the work runs under (`lib/workAuthority.ts`); null when it
  // has none, and such work is refused.
  @Column({ type: DataType.JSON, allowNull: true })
  declare authority: object | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare startedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare finishedAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}

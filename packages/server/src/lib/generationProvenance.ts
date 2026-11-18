/**
 * Where a turn's context came from, as two counts: results from tools whose
 * output is not trusted, and knowledge. `runtime.generations.*` reads them
 * (`guardrailRuntimeCatalog.ts`).
 *
 * A result counts when it enters the context, by what its tool declared then,
 * so a later `trusted_output` edit does not rewrite a chain. A call is judged
 * on the counts at the start of the step that proposed it ({@link
 * GenerationProvenance.step}). The counts are stored as numbers on the
 * generation row, never derived from content, so they outlive a purge.
 */
import { db } from '../db';

export const PROVENANCE_METRICS = [
  'untrusted_tool_results',
  'knowledge_results',
] as const;

export type ProvenanceMetric = (typeof PROVENANCE_METRICS)[number];

export type ProvenanceCounts = Record<ProvenanceMetric, number>;

export const NO_PROVENANCE: ProvenanceCounts = {
  untrusted_tool_results: 0,
  knowledge_results: 0,
};

export const isProvenanceMetric = (
  value: string
): value is ProvenanceMetric => {
  return (PROVENANCE_METRICS as readonly string[]).includes(value);
};

const add = (a: ProvenanceCounts, b: ProvenanceCounts): ProvenanceCounts => {
  return {
    untrusted_tool_results: a.untrusted_tool_results + b.untrusted_tool_results,
    knowledge_results: a.knowledge_results + b.knowledge_results,
  };
};

const subtract = (
  a: ProvenanceCounts,
  b: ProvenanceCounts
): ProvenanceCounts => {
  return {
    untrusted_tool_results: a.untrusted_tool_results - b.untrusted_tool_results,
    knowledge_results: a.knowledge_results - b.knowledge_results,
  };
};

const isZero = (counts: ProvenanceCounts): boolean => {
  return counts.untrusted_tool_results === 0 && counts.knowledge_results === 0;
};

/** One count of `metric`, or none for `null`. */
export const countOf = (
  metric: ProvenanceMetric | null,
  count = 1
): ProvenanceCounts => {
  return metric ? { ...NO_PROVENANCE, [metric]: count } : NO_PROVENANCE;
};

// Builtin actions that read knowledge feed `knowledge_results` whatever the
// tool's `trusted_output`: the counter describes the content, not the path.
const KNOWLEDGE_ACTIONS: ReadonlySet<string> = new Set([
  'search-knowledge',
  'get-document',
]);

/**
 * The counter a tool's result feeds, or `null` when its tool declares its
 * output trusted.
 */
export const resultProvenance = (args: {
  toolType: string;
  action: string | null | undefined;
  trustedOutput: boolean;
}): ProvenanceMetric | null => {
  if (
    args.toolType === 'builtin' &&
    args.action &&
    KNOWLEDGE_ACTIONS.has(args.action)
  ) {
    return 'knowledge_results';
  }
  return args.trustedOutput ? null : 'untrusted_tool_results';
};

/** {@link resultProvenance} of a stored tool; an unknown one counts untrusted. */
export const storedToolResultProvenance = async (args: {
  toolId: string;
  action: string | null | undefined;
}): Promise<ProvenanceMetric | null> => {
  const tool = await db.Tool.findOne({
    where: { publicId: args.toolId },
    attributes: ['type', 'trustedOutput'],
  });
  return resultProvenance({
    toolType: tool?.type ?? 'unknown',
    action: args.action,
    trustedOutput: tool?.trustedOutput ?? false,
  });
};

/**
 * A turn's tally: `live` is what has entered the context; `step` is what had
 * when the current step started, which is what a call it proposes is judged
 * on. A result arriving mid-step, a parallel sibling's included, counts from
 * the next step.
 */
export type GenerationProvenance = {
  record: (counts: ProvenanceCounts) => void;
  startStep: () => void;
  step: () => ProvenanceCounts;
  live: () => ProvenanceCounts;
  /** What `live` holds beyond what the row stores, marked stored. */
  takeUnpersisted: () => ProvenanceCounts;
};

/** A tally starting from `stored`, the counts its generation row holds. */
export const createGenerationProvenance = (
  stored: ProvenanceCounts = NO_PROVENANCE
): GenerationProvenance => {
  let live = stored;
  let step = stored;
  let persisted = stored;
  return {
    record: (counts) => {
      live = add(live, counts);
    },
    startStep: () => {
      step = live;
    },
    step: () => {
      return step;
    },
    live: () => {
      return live;
    },
    takeUnpersisted: () => {
      const unpersisted = subtract(live, persisted);
      persisted = live;
      return unpersisted;
    },
  };
};

// ── Persistence ───────────────────────────────────────────────────────────

/**
 * The row columns for counts a generation is created with, or a conversation
 * message is stamped with.
 */
export const provenanceColumns = (counts: ProvenanceCounts) => {
  return {
    untrustedToolResults: counts.untrusted_tool_results,
    knowledgeResults: counts.knowledge_results,
  };
};

/** The counts a generation or conversation message row stores. */
export const storedProvenance = (row: {
  untrustedToolResults: number;
  knowledgeResults: number;
}): ProvenanceCounts => {
  return {
    untrusted_tool_results: row.untrustedToolResults,
    knowledge_results: row.knowledgeResults,
  };
};

/** The generation columns for the counts a turn took from its conversation. */
export const replayedProvenanceColumns = (counts: ProvenanceCounts) => {
  return {
    replayedUntrustedToolResults: counts.untrusted_tool_results,
    replayedKnowledgeResults: counts.knowledge_results,
  };
};

/** The counts a new generation row is created with, marked stored. */
export const provenanceForNewRow = (
  provenance: GenerationProvenance
): ProvenanceCounts => {
  const counts = provenance.live();
  provenance.takeUnpersisted();
  return counts;
};

// Increments, never absolute writes: an approved call's result lands on the
// row while its turn may still be running and holding its own tally.
const incrementColumns = (counts: ProvenanceCounts) => {
  const { sequelize } = db;
  return {
    untrustedToolResults: sequelize.literal(
      `untrusted_tool_results + ${Math.trunc(counts.untrusted_tool_results)}`
    ),
    knowledgeResults: sequelize.literal(
      `knowledge_results + ${Math.trunc(counts.knowledge_results)}`
    ),
  };
};

// The tallies of the turns this process is running, so a status write folds
// in what the turn read since its last one.
const tracked = new Map<string, GenerationProvenance>();

export const trackGenerationProvenance = (args: {
  generationId: string;
  provenance: GenerationProvenance;
}): void => {
  tracked.set(args.generationId, args.provenance);
};

const SETTLED_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/**
 * The column updates a status write of `generationId` carries: what its turn
 * read since the row was last written. Empty when it read nothing new.
 */
export const provenanceStatusUpdates = (args: {
  generationId: string;
  status: string | undefined;
}): Record<string, unknown> => {
  const provenance = tracked.get(args.generationId);
  if (!provenance) return {};
  if (args.status && SETTLED_STATUSES.has(args.status)) {
    tracked.delete(args.generationId);
  }
  const unpersisted = provenance.takeUnpersisted();
  return isZero(unpersisted) ? {} : incrementColumns(unpersisted);
};

/** Adds `counts` to a generation's stored ones. */
export const addGenerationProvenance = async (args: {
  generationId: string;
  counts: ProvenanceCounts;
}): Promise<void> => {
  if (isZero(args.counts)) return;
  await db.Generation.update(incrementColumns(args.counts), {
    where: { publicId: args.generationId },
  });
};

/** Adds a stored tool's result to the generation it entered, if any. */
export const countStoredToolResult = async (args: {
  generationId: string | null | undefined;
  toolId: string;
  action: string | null | undefined;
}): Promise<void> => {
  if (!args.generationId) return;
  await addGenerationProvenance({
    generationId: args.generationId,
    counts: countOf(await storedToolResultProvenance(args)),
  });
};

/** Stores what a running turn read since its row was last written. */
export const persistGenerationProvenance = (args: {
  generationId: string;
  provenance: GenerationProvenance;
}): Promise<void> => {
  return addGenerationProvenance({
    generationId: args.generationId,
    counts: args.provenance.takeUnpersisted(),
  });
};

/**
 * A generation's stored counts, or none when there is no such row. With
 * `withoutReplayed`, less what it took from the conversation messages it was
 * sent: what a turn that replays the conversation itself inherits, and what
 * its reply's message is stamped with.
 */
export const readGenerationProvenance = async (args: {
  generationId: string | null | undefined;
  withoutReplayed: boolean;
}): Promise<ProvenanceCounts> => {
  if (!args.generationId) return NO_PROVENANCE;
  const row = await db.Generation.findOne({
    where: { publicId: args.generationId },
    attributes: [
      'untrustedToolResults',
      'knowledgeResults',
      'replayedUntrustedToolResults',
      'replayedKnowledgeResults',
    ],
  });
  if (!row) return NO_PROVENANCE;
  const total = storedProvenance(row);
  if (!args.withoutReplayed) return total;
  return subtract(total, {
    untrusted_tool_results: row.replayedUntrustedToolResults,
    knowledge_results: row.replayedKnowledgeResults,
  });
};

export const sumProvenance = (
  ...counts: ProvenanceCounts[]
): ProvenanceCounts => {
  return counts.reduce(add, NO_PROVENANCE);
};

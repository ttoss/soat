/**
 * Reciprocal rank fusion — how the knowledge search turns several ranked
 * candidate lists into one order.
 *
 * The lists it fuses come from different scoring systems: cosine distance on an
 * embedding, `ts_rank_cd` on a `tsvector`. Their magnitudes are not comparable
 * — a cosine of `0.62` and a lexical rank of `0.1` say nothing about each other
 * — so the previous merge, which sorted the concatenation by raw score, was
 * really a vector-only ranking with lexical hits dropped wherever the scales
 * disagreed. RRF reads only each result's *position* in each list, which is the
 * one thing the systems report on a common scale.
 *
 * One signal RRF cannot read is time, because time is not a ranking over the
 * corpus: a memory fact is worth less than an equally relevant fresher one,
 * while a document chunk is worth exactly the same however old it is. That is
 * applied to the fused score, per result, after fusion — see
 * {@link resolveRecencyHalfLifeDays}.
 */

/** The `k` in `1 / (k + rank)` when neither request nor deployment names one. */
export const DEFAULT_RRF_K = 60;

const readDeploymentRrfK = (): number | undefined => {
  const raw = process.env.KNOWLEDGE_RRF_K;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.floor(parsed);
};

/**
 * The `k` one search fuses with: the request's value, else the deployment's
 * `KNOWLEDGE_RRF_K`, else {@link DEFAULT_RRF_K}.
 *
 * Out-of-range input falls back rather than being refused, the same way
 * `clampKnowledgeSearchLimit` treats `limit`: `k` shifts how steeply rank
 * position is discounted, and no value of it can return a wrong result.
 */
export const resolveRrfK = (rrfK?: number): number => {
  if (rrfK !== undefined && Number.isFinite(rrfK) && rrfK >= 1) {
    return Math.floor(rrfK);
  }
  return readDeploymentRrfK() ?? DEFAULT_RRF_K;
};

export type SignalCandidate<T> = {
  item: T;
  /**
   * The value this signal ranked the candidate by — cosine similarity for the
   * vector signal, `ts_rank_cd` for the lexical one. Comparable only against
   * other candidates of the same signal, which is why it never leaves this
   * layer: it exists to merge a signal's per-store shards back into the one
   * ranking that signal produces.
   */
  signal: number;
};

/**
 * One signal's ranking over the whole knowledge corpus, assembled from the
 * per-store queries that computed it.
 *
 * Documents and memory entries are queried separately because they are separate
 * tables — not because they are separate rankings. Fusing the shards as if they
 * were four independent rankings is what breaks: RRF reads position, so the
 * tenth-best memory entry and the tenth-best chunk would score identically and
 * each store would claim half the result slots whatever its rows are worth. The
 * shards are merged on the signal's own value first, which is comparable across
 * stores — both embed through one provider into one vector space, and
 * `ts_rank_cd` is the same function over the same configuration — and only the
 * two cross-store rankings are fused.
 */
export const mergeSignalShards = <T>(args: {
  shards: Array<ReadonlyArray<SignalCandidate<T>>>;
}): T[] => {
  return args.shards
    .flat()
    .sort((a, b) => {
      return b.signal - a.signal;
    })
    .map((candidate) => {
      return candidate.item;
    });
};

/**
 * What one store contributes to a search: its shard of each signal's ranking
 * when the request carries a query, and a single unranked list — the store's
 * deterministic read — when it does not.
 */
export type SearchCandidates<T> =
  | { ranked: false; results: T[] }
  | {
      ranked: true;
      vector: Array<SignalCandidate<T>>;
      lexical: Array<SignalCandidate<T>>;
    };

export type FusedResult<T> = {
  item: T;
  /**
   * `Σ 1 / (k + rank_i)` over the lists this result appears in. Ordering-only:
   * the value has no scale a caller can read, and is deliberately not rescaled
   * into `0..1`, which would lend it a stability the contract refuses.
   */
  score: number;
};

/**
 * Fuses ranked lists, best first within each, into one order.
 *
 * A result that several lists agree on accumulates their contributions and
 * outranks a result only one list ranks highly — which is the whole point: a
 * chunk that is both semantically close and contains the searched token is
 * better evidence than either signal alone.
 *
 * One list per *signal*, never per store: see {@link mergeSignalShards}.
 *
 * `keyOf` decides identity, so the same row reached through two signals fuses
 * instead of appearing twice. The first list to produce a key keeps its
 * representative object: every list selects the same columns, so they differ
 * only in how they were found.
 */
export const fuseByReciprocalRank = <T>(args: {
  lists: ReadonlyArray<readonly T[]>;
  keyOf: (item: T) => string;
  k: number;
}): Array<FusedResult<T>> => {
  const fused = new Map<string, FusedResult<T>>();

  for (const list of args.lists) {
    for (const [index, item] of list.entries()) {
      const key = args.keyOf(item);
      const contribution = 1 / (args.k + index + 1);
      const existing = fused.get(key);
      if (existing) {
        existing.score += contribution;
        continue;
      }
      fused.set(key, { item, score: contribution });
    }
  }

  // `sort` is stable, so results that fuse to the same score keep the order the
  // lists introduced them in — the first list's ranking breaks the tie.
  return [...fused.values()].sort((a, b) => {
    return b.score - a.score;
  });
};

/**
 * The half-life in days when neither the request nor the deployment names one.
 *
 * Zero, which disables the blend: turning it on would silently reorder every
 * existing deployment's memory results on upgrade, by a half-life nobody has
 * measured against their corpus. The knobs are the feature; the recommended
 * value is documented, not baked in.
 */
export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 0;

const readDeploymentRecencyHalfLifeDays = (): number | undefined => {
  const raw = process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
};

/**
 * The half-life one search decays memory results by: the request's value, else
 * the deployment's `KNOWLEDGE_RECENCY_HALF_LIFE_DAYS`, else
 * {@link DEFAULT_RECENCY_HALF_LIFE_DAYS}.
 *
 * Days, as a float: this repository's retention-scale knobs are days
 * (`AUDIT_RETENTION_DAYS`, `traceContentRetentionDays`) and its operation-scale
 * ones milliseconds, and age is read from a column consolidation bumps — at
 * hour resolution the ranking would partly track when consolidation last ran.
 * The float is what keeps `0.5` reachable while leaving `30` readable.
 *
 * `0` disables the blend at either level. A half-life of zero days is not a
 * meaningful limit, so the sentinel collides with no real value, and a request
 * `0` is what serves an archival query on a deployment that wants decay
 * everywhere else. Out-of-range input falls back rather than being refused, the
 * same way {@link resolveRrfK} treats `k`: this reorders results, it cannot
 * make one wrong.
 */
export const resolveRecencyHalfLifeDays = (halfLifeDays?: number): number => {
  if (
    halfLifeDays !== undefined &&
    Number.isFinite(halfLifeDays) &&
    halfLifeDays >= 0
  ) {
    return halfLifeDays;
  }
  return readDeploymentRecencyHalfLifeDays() ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
};

const MS_PER_DAY = 86400000;

/**
 * `2 ^ (−age / half_life)` — a fact half as useful every half-life.
 *
 * Age is read from `updated_at`, not `created_at`, so a consolidation merge
 * that re-asserts a fact refreshes it rather than letting the system age out
 * knowledge it keeps re-confirming. The cost is that a PATCH or a tag edit
 * re-asserts it too: any write to the entry counts as one.
 *
 * A timestamp in the future returns `1`: clock skew between the writer and the
 * reader is not evidence of freshness, and a factor above `1` would promote a
 * result rather than decay it.
 */
export const recencyDecayFactor = (args: {
  updatedAt: Date;
  /** Read once per response, so two results can never be compared across a tick. */
  now: number;
  halfLifeDays: number;
}): number => {
  if (args.halfLifeDays <= 0) return 1;
  const ageDays = (args.now - args.updatedAt.getTime()) / MS_PER_DAY;
  if (!(ageDays > 0)) return 1;
  return 2 ** (-ageDays / args.halfLifeDays);
};

/**
 * Multiplies each memory result's fused score by its decay and re-sorts.
 *
 * Applied per result **after** fusion, never as a third ranked list: a
 * per-store list is the defect #1272 measured, where each store claims result
 * slots by position rather than by what its rows are worth.
 *
 * Document results are left alone — a fact goes stale, a paragraph of a manual
 * does not — and at a half-life of `0` the fused order is returned as it came,
 * so an untouched deployment's ranking is identical to the pre-blend one rather
 * than merely equal to it.
 */
const blendRecency = <T extends { updated_at: Date }>(args: {
  fused: Array<FusedResult<T>>;
  isMemory: (item: T) => boolean;
  halfLifeDays: number;
}): Array<FusedResult<T>> => {
  if (args.halfLifeDays <= 0) return args.fused;

  // One clock read for the whole response: two results measured against two
  // ticks could order inconsistently, and a test could not freeze it.
  const now = Date.now();

  return (
    args.fused
      .map((result) => {
        if (!args.isMemory(result.item)) return result;
        const decay = recencyDecayFactor({
          updatedAt: result.item.updated_at,
          now,
          halfLifeDays: args.halfLifeDays,
        });
        return { item: result.item, score: result.score * decay };
      })
      // Stable, so two results the blend leaves at the same score keep the order
      // fusion gave them.
      .sort((a, b) => {
        return b.score - a.score;
      })
  );
};

/**
 * The whole ranking step of a search: merge each signal's per-store shards,
 * fuse the two resulting rankings, decay the memory results by their age, take
 * the top `limit`, and stamp the resulting score onto each result.
 *
 * The blend runs before the `slice`, so a fact its age demotes gives up its
 * result slot rather than merely its position inside one.
 *
 * One function rather than the same six lines at each call site — the two
 * single-store entry points and the cross-store one differ only in how many
 * shards they hand each signal.
 *
 * `slice` is a top-k of an in-memory ranking, not a page: there is no stable
 * order to offset into, which is why knowledge search has no `offset`.
 */
export const fuseCandidates = <
  T extends { score?: number; updated_at: Date },
>(args: {
  vector: Array<ReadonlyArray<SignalCandidate<T>>>;
  lexical: Array<ReadonlyArray<SignalCandidate<T>>>;
  keyOf: (item: T) => string;
  rrfK?: number;
  /**
   * Which results the recency blend applies to. A predicate rather than a
   * property: `QueryDocumentResult` carries no discriminant, and the two
   * single-store entry points answer it with a constant.
   */
  isMemory: (item: T) => boolean;
  /** Days. See {@link resolveRecencyHalfLifeDays}; `0` disables the blend. */
  recencyHalfLifeDays?: number;
  limit: number;
}): T[] => {
  const fused = fuseByReciprocalRank({
    lists: [
      mergeSignalShards({ shards: args.vector }),
      mergeSignalShards({ shards: args.lexical }),
    ],
    keyOf: args.keyOf,
    k: resolveRrfK(args.rrfK),
  });

  return blendRecency({
    fused,
    isMemory: args.isMemory,
    halfLifeDays: resolveRecencyHalfLifeDays(args.recencyHalfLifeDays),
  })
    .slice(0, args.limit)
    .map((result) => {
      return { ...result.item, score: result.score };
    });
};

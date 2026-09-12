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

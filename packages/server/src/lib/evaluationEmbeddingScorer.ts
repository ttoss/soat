/**
 * The `embedding_similarity` scorer's pure contract (the evaluations module
 * doc): the cosine math and the outcome semantics. Split from
 * `evaluationScorers.ts` the same way the tool scorer's contract is
 * (`evaluationToolScorerContract.ts`), and re-exported there so consumers of
 * the scorer algebra see one surface.
 *
 * Embedding is I/O, so — like judging — the call is injected (see
 * {@link EmbeddingScorerRunner}); the run path passes `getEmbeddings` from
 * `embedding.ts`, the same env-configured stack document ingestion uses.
 */
import type { ScoredOutput, ScorerOutcome } from './evaluationScorers';
import { isUnitInterval } from './evaluationToolScorerContract';

/**
 * How embeddings are obtained for an `embedding_similarity` scorer. Matches
 * `getEmbeddings` from `embedding.ts` exactly, so the run path injects that
 * function unchanged and a test supplies fixed vectors.
 *
 * A rejection propagates out of `scoreOutput` — the caller records the item as
 * **errored**, never as a 0: an embedding backend that cannot answer says
 * nothing about the agent (the same rule as a failed judge).
 */
export type EmbeddingScorerRunner = (args: {
  texts: string[];
}) => Promise<number[][]>;

/**
 * The scorer's config rules. `pass_threshold` is required with no default, for
 * the same reason as `llm_judge`'s: cosine similarity is a continuous score,
 * and nothing about it says where "close enough" is for an eval's domain.
 */
export const checkEmbeddingScorerConfig = (args: {
  scorer: Record<string, unknown>;
  path: string;
}): string | null => {
  if (!isUnitInterval(args.scorer.pass_threshold)) {
    return `${args.path}.pass_threshold is required and must be a number between 0 and 1.`;
  }
  return null;
};

/** The scorer key `embedding_similarity` outcomes and aggregates use. */
export const EMBEDDING_SCORER_TYPE = 'embedding_similarity';

/**
 * Cosine similarity of two vectors, clamped to 0–1 so it satisfies the scorer
 * contract (embedding models can emit a negative cosine for very dissimilar
 * texts; every value below 0 is equally "not the reference"). A zero-magnitude
 * vector has no direction to compare, so the similarity is 0, not NaN.
 */
export const cosineSimilarity = (a: number[], b: number[]): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  const cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.min(1, Math.max(0, cosine));
};

export const scoreEmbeddingSimilarity = async (args: {
  scorer: Record<string, unknown>;
  output: ScoredOutput;
  expectedOutput: string | null;
  runEmbeddings: EmbeddingScorerRunner;
}): Promise<ScorerOutcome> => {
  // Like `exact_match`: the reference answer is what similarity is measured
  // against, so an item without one cannot pass — and there is nothing to
  // embed, so the backend is never called.
  if (args.expectedOutput === null) {
    return { scorer: EMBEDDING_SCORER_TYPE, score: 0, passed: false };
  }

  const [outputVector, expectedVector] = await args.runEmbeddings({
    texts: [args.output.content, args.expectedOutput],
  });

  const score = cosineSimilarity(outputVector, expectedVector);
  const threshold = Number(args.scorer.pass_threshold);
  // `>=`, so a score exactly at the threshold passes — same as `llm_judge`.
  return {
    scorer: EMBEDDING_SCORER_TYPE,
    score,
    passed: score >= threshold,
  };
};

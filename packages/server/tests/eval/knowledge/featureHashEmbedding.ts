/**
 * Deterministic fixture embedder for the retrieval eval.
 *
 * The unit suite's stub returns one constant vector for every input, so every
 * cosine score ties and no ranking change is observable. This replaces it for
 * the eval with feature hashing: each text becomes a signed, L2-normalised bag
 * of its tokens and character trigrams, so two texts sharing terms score high
 * and two that share none score near zero — deterministic, distinct per text,
 * and ordered by term overlap.
 *
 * It is itself lexical, so it understates the gap a real vector model would
 * show between a lexical and a semantic match. That is the known cost of
 * running the gate without a provider in CI; an `EVAL_EMBEDDINGS=provider` mode
 * is worth adding if a ranking result on these fixtures ever contradicts a spot
 * check against a real model.
 */

/**
 * Weights are exact binary fractions, and each distinct feature is counted
 * once. Both are load-bearing: the per-dimension sums are then exact, so the
 * vector does not depend on the order features happen to be visited in, and two
 * runs over the same corpus produce byte-identical numbers.
 */
const TOKEN_WEIGHT = 1;
const TRIGRAM_WEIGHT = 0.25;
const TRIGRAM_SIZE = 3;

const FNV_PRIME = 16777619;
const INDEX_SEED = 2166136261;
const SIGN_SEED = 1099511628;

/**
 * A word, keeping internal `-`, `_` and `.` so an identifier such as
 * `SKU-4711` stays one token. Split into `sku` and `4711` it would match every
 * other SKU in the corpus and the exact-token queries would stop
 * discriminating.
 */
const TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu;
const TRAILING_PUNCTUATION = /[._-]+$/;

const fnv1a = (args: { text: string; seed: number }): number => {
  let hash = args.seed >>> 0;
  for (let i = 0; i < args.text.length; i += 1) {
    hash ^= args.text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
};

const tokenize = (args: { text: string }): string[] => {
  const matches = args.text.toLowerCase().match(TOKEN_PATTERN) ?? [];
  return matches
    .map((token) => {
      return token.replace(TRAILING_PUNCTUATION, '');
    })
    .filter(Boolean);
};

const trigramsOf = (args: { token: string }): string[] => {
  // The boundary markers make a prefix or suffix match a feature of its own, so
  // `chunk` and `chunking` overlap instead of being orthogonal.
  const padded = `^${args.token}$`;
  const grams: string[] = [];
  for (let i = 0; i + TRIGRAM_SIZE <= padded.length; i += 1) {
    grams.push(padded.slice(i, i + TRIGRAM_SIZE));
  }
  return grams;
};

const collectFeatures = (args: { text: string }): Map<string, number> => {
  const features = new Map<string, number>();
  for (const token of tokenize({ text: args.text })) {
    features.set(`t:${token}`, TOKEN_WEIGHT);
    for (const gram of trigramsOf({ token })) {
      features.set(`g:${gram}`, TRIGRAM_WEIGHT);
    }
  }
  return features;
};

/**
 * Unit vector used for a text with no tokens at all. A zero vector would make
 * every pgvector cosine distance `NaN`, and `NaN` sorts unpredictably — the one
 * thing a ranking fixture may never do.
 */
const emptyTextVector = (args: { dimensions: number }): number[] => {
  const vector = Array<number>(args.dimensions).fill(0);
  vector[0] = 1;
  return vector;
};

export const featureHashEmbedding = (args: {
  text: string;
  dimensions: number;
}): number[] => {
  if (!Number.isInteger(args.dimensions) || args.dimensions < 1) {
    throw new Error(
      `dimensions must be a positive integer, received ${args.dimensions}`
    );
  }

  const features = collectFeatures({ text: args.text });
  if (features.size === 0) return emptyTextVector(args);

  const vector = Array<number>(args.dimensions).fill(0);

  for (const [feature, weight] of features) {
    const index = fnv1a({ text: feature, seed: INDEX_SEED }) % args.dimensions;
    const sign = fnv1a({ text: feature, seed: SIGN_SEED }) % 2 === 0 ? 1 : -1;
    vector[index] += sign * weight;
  }

  const norm = Math.sqrt(
    vector.reduce((total, value) => {
      return total + value * value;
    }, 0)
  );

  // Every feature landing on one dimension with cancelling signs is the only
  // way a non-empty text reaches a zero norm.
  if (norm === 0) return emptyTextVector(args);

  return vector.map((value) => {
    return value / norm;
  });
};

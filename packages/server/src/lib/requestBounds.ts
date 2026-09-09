/**
 * Ceilings on what one request may make this process buffer or compute, kept
 * together so the whole set is auditable in one place. Each is enforced at the
 * single point every caller of that work converges on, never at the route.
 */

/** Files above this are refused while the body is still streaming. */
const UPLOAD_DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Configurable via FILE_UPLOAD_MAX_BYTES, and read per request rather than at
 * module load: multer fixes its limits at construction, so a value read once
 * would pin the deployment's ceiling to whatever the environment held when the
 * router was first imported.
 */
export const getUploadMaxBytes = (): number => {
  const raw = process.env.FILE_UPLOAD_MAX_BYTES;
  if (!raw) return UPLOAD_DEFAULT_MAX_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : UPLOAD_DEFAULT_MAX_BYTES;
};

/** Embedding inputs per request: one call per input reaches the provider. */
export const MAX_EMBEDDINGS_INPUTS = 256;

/** Results a knowledge search returns when the caller names no `limit`. */
export const DEFAULT_KNOWLEDGE_SEARCH_TOP_K = 10;

/** Ceiling on the rows a single knowledge search asks the vector scan for. */
export const MAX_KNOWLEDGE_SEARCH_TOP_K = 100;

/**
 * Clamped rather than refused: the ceiling is a bound on this process's work,
 * not a contract a caller agreed to, and a caller who has always sent a larger
 * `limit` keeps getting everything there is to return.
 */
export const clampKnowledgeSearchLimit = (limit?: number): number => {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_KNOWLEDGE_SEARCH_TOP_K;
  }
  return Math.min(Math.floor(limit), MAX_KNOWLEDGE_SEARCH_TOP_K);
};

/**
 * Wildcards allowed in one `content_type_glob`. A MIME glob needs at most two
 * (one on each side of the slash); the cap keeps a stored pattern from turning
 * every ingestion match into a long walk. It bounds new rows only — the
 * matcher itself is linear whatever it is handed.
 */
export const MAX_CONTENT_TYPE_GLOB_WILDCARDS = 4;

/** Longest `content_type_glob` accepted, well past any real MIME type. */
export const MAX_CONTENT_TYPE_GLOB_LENGTH = 255;

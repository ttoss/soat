import { isParam, isRef, isRefAttr, isSub } from './formationsHelpers';
import type { ValidationError } from './formationsTypes';

// The formation-level `metadata` field (a sibling of `template`) is a static
// annotation bag — unlike the template's top-level `metadata` block, it is NOT
// a substitution site. A `sub`/`param`/`ref`/`ref_attr` expression placed here
// would be stored verbatim and silently never resolved (F-16), so reject it up
// front and point the author at `template.metadata`, which is resolved at
// deploy time and exposed on `resolved_metadata`.
const STATIC_METADATA_HINT =
  "Put deploy-time substitutions in the template's top-level `metadata` block, which is resolved into `resolved_metadata`.";

const expressionKind = (value: unknown): string | null => {
  if (isSub(value)) return 'sub';
  if (isParam(value)) return 'param';
  if (isRef(value)) return 'ref';
  if (isRefAttr(value)) return 'ref_attr';
  return null;
};

/**
 * Walks the formation-level `metadata` field and reports any substitution
 * expression (`sub`/`param`/`ref`/`ref_attr`) found at any depth. Returns an
 * empty array for plain static metadata.
 */
export const detectStaticMetadataViolations = (
  metadata: unknown,
  path = 'metadata'
): ValidationError[] => {
  const kind = expressionKind(metadata);
  if (kind) {
    return [
      {
        path,
        message: `\`${kind}\` expressions are not allowed in the formation \`metadata\` field. ${STATIC_METADATA_HINT}`,
      },
    ];
  }
  if (Array.isArray(metadata)) {
    return metadata.flatMap((item, index) => {
      return detectStaticMetadataViolations(item, `${path}[${index}]`);
    });
  }
  if (typeof metadata === 'object' && metadata !== null) {
    return Object.entries(metadata as Record<string, unknown>).flatMap(
      ([key, value]) => {
        return detectStaticMetadataViolations(value, `${path}.${key}`);
      }
    );
  }
  return [];
};

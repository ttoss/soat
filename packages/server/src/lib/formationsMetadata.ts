import { isParam, isRef, isRefAttr, isSub } from './formationsHelpers';
import type { ValidationError } from './formationsTypes';

// Unlike `template.metadata`, this is not a substitution site — an expression
// placed here would be stored verbatim and silently never resolved, so it is
// rejected up front with a pointer to the field that does resolve.
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

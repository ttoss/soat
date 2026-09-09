/**
 * Reference validation for a formation template: the `ref` / `param` / `sub`
 * tokens that may appear at any substitution site, and the `ref_attr`
 * expressions only the `outputs` block may carry.
 */

import {
  collectParamRefs,
  collectRefAttrs,
  collectRefs,
  parseRefAttr,
} from './formationsHelpers';
import { isSensitiveAttribute } from './formationsSensitive';
import type { ValidationError } from './formationsTypes';
import { isPlainObject } from './plainObject';

// ── Ref / Param Token Validation ──────────────────────────────────────────

// Validates `ref` and `param`/`sub` tokens anywhere within `value`, attributing
// every error to `path`. Shared by resource `properties`, the top-level
// `outputs`, and `metadata` substitution sites.
export const validateRefAndParamTokens = (
  value: unknown,
  path: string,
  logicalIds: Set<string>,
  paramNames: Set<string>
): ValidationError[] => {
  const errors: ValidationError[] = [];
  for (const ref of collectRefs(value)) {
    if (!logicalIds.has(ref)) {
      errors.push({
        path,
        message: `Referenced resource '${ref}' does not exist in template`,
      });
    }
  }
  for (const ref of collectParamRefs(value)) {
    // body.xxx refs are runtime tool-argument interpolations, not formation params
    if (ref.startsWith('body.')) continue;
    // A sub token may also name a resource logical id (resolved to the
    // physical id at apply time).
    if (logicalIds.has(ref)) continue;
    if (!paramNames.has(ref)) {
      errors.push({
        path,
        message: `'${ref}' is neither a parameter nor a resource logical id`,
      });
    }
  }
  return errors;
};

// ── Output Ref Validation ─────────────────────────────────────────────────

// A declaration that is not an object has already been reported by
// `validateResourceDeclaration`; this asks only whether its type is readable.
const readResourceType = (decl: unknown): string | undefined => {
  if (!isPlainObject(decl)) return undefined;
  return typeof decl.type === 'string' ? decl.type : undefined;
};

export const validateOutputRefs = (args: {
  outputs: Record<string, unknown>;
  resources: Record<string, unknown>;
  logicalIds: Set<string>;
  paramNames: Set<string>;
}): ValidationError[] => {
  const { outputs, resources, logicalIds, paramNames } = args;
  const errors: ValidationError[] = [];
  for (const [outputName, outputValue] of Object.entries(outputs)) {
    const path = `outputs.${outputName}`;
    errors.push(
      ...validateRefAndParamTokens(outputValue, path, logicalIds, paramNames)
    );
    for (const refAttr of collectRefAttrs(outputValue)) {
      const parsed = parseRefAttr(refAttr);
      if (!parsed) {
        errors.push({
          path,
          message: `ref_attr '${refAttr}' must be in the form '<ResourceName>.<attribute>'`,
        });
        continue;
      }
      if (!logicalIds.has(parsed.logicalId)) {
        errors.push({
          path,
          message: `Referenced resource '${parsed.logicalId}' does not exist in template`,
        });
        continue;
      }
      const resourceType = readResourceType(resources[parsed.logicalId]);
      if (
        resourceType &&
        isSensitiveAttribute({ resourceType, attrName: parsed.attrName })
      ) {
        errors.push({
          path,
          message: `Attribute '${parsed.attrName}' of resource '${parsed.logicalId}' is a credential and cannot be a formation output — a formation is readable by anyone holding formations:GetFormation. Read it from the resource's own secret route instead.`,
        });
      }
    }
  }
  return errors;
};

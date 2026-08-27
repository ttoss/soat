/**
 * The half of template validation that has to leave the process.
 *
 * Only an operator-registered resource type (#1078) has one today: a
 * registration declaring the `validate` capability gets a plan-time round trip
 * to its handler for the checks a JSON Schema cannot express. Every built-in is
 * fully validated synchronously, so a deployment registering nothing adds one
 * pass over the resources and no I/O.
 *
 * Beside `formationsValidation.ts` rather than inside it so that file stays
 * synchronous: `validateFormationTemplate` is called from tests, the plan
 * pipeline and four routes, and making it async for one optional capability
 * would ripple through all of them.
 */

import { normalizeDeclaredProperties } from './formationsProperties';
import { getFormationModule } from './formationsRegistry';
import type { ValidationError, ValidationResult } from './formationsTypes';
import { validateFormationTemplate } from './formationsValidation';
import { isPlainObject } from './plainObject';

/**
 * The handler errors for one resource declaration, or nothing when its type
 * declares no async validation.
 */
const validateDeclaration = async (args: {
  logicalId: string;
  declRaw: unknown;
}): Promise<ValidationError[]> => {
  const { logicalId, declRaw } = args;
  if (!isPlainObject(declRaw)) return [];

  const type = declRaw.type;
  if (typeof type !== 'string') return [];

  const hook = getFormationModule({
    resourceType: type,
  })?.validatePropertiesAsync;
  if (!hook) return [];

  return hook({
    // The same shallow declaration normalization the synchronous seam applies,
    // so a handler sees the key spelling the schema declares (#901).
    properties: isPlainObject(declRaw.properties)
      ? normalizeDeclaredProperties(declRaw.properties)
      : declRaw.properties,
    basePath: `resources.${logicalId}.properties`,
  });
};

/**
 * The template's own validation, plus whatever its resource types want to ask
 * an external handler.
 *
 * The handler pass runs **only** on a template that already validates locally.
 * A template with a malformed resource has nothing coherent to ask a handler
 * about, and asking anyway would send a half-checked bag to an external service
 * on every typo.
 */
export const validateFormationTemplateAsync = async (
  template: unknown
): Promise<ValidationResult> => {
  const result = validateFormationTemplate(template);
  if (!result.valid) return result;

  /* istanbul ignore next — a valid template always parses to a resources map. */
  const resources =
    isPlainObject(template) && isPlainObject(template.resources)
      ? template.resources
      : {};

  const errors: ValidationError[] = [];
  for (const [logicalId, declRaw] of Object.entries(resources)) {
    errors.push(...(await validateDeclaration({ logicalId, declRaw })));
  }

  if (errors.length === 0) return result;
  return { valid: false, errors, warnings: result.warnings };
};

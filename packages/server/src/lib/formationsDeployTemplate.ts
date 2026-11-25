import { isDeepStrictEqual } from 'node:util';

import { Op } from '@ttoss/postgresdb';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { missingParameterErrors } from './formationsHelpers';
import { resolveParameterValues } from './formationsParameters';
import type { FormationTemplate } from './formationsTypes';
import { parseFormationTemplateInput } from './formationsValidation';
import { validateFormationTemplateAsync } from './formationsValidationAsync';
import { isPlainObject } from './plainObject';

/**
 * A formation read masks every credential in its template, so a caller who
 * edits what it read sends `{ no_echo: true }` where the stored value was.
 * Each such placeholder is put back to the stored value at the same path,
 * and only in a resource that then equals its stored declaration: a caller
 * may keep a credential it cannot see where it stands, never move it into a
 * changed resource.
 */

const isPlaceholder = (value: unknown): boolean => {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 1 &&
    value.no_echo === true
  );
};

const holdsPlaceholder = (value: unknown): boolean => {
  if (isPlaceholder(value)) return true;
  if (Array.isArray(value)) return value.some(holdsPlaceholder);
  return isPlainObject(value) && Object.values(value).some(holdsPlaceholder);
};

const restore = (incoming: unknown, stored: unknown): unknown => {
  if (isPlaceholder(incoming)) return stored;
  if (Array.isArray(incoming)) {
    return incoming.map((entry, index) => {
      return restore(entry, Array.isArray(stored) ? stored[index] : undefined);
    });
  }
  if (!isPlainObject(incoming)) return incoming;
  const bag = isPlainObject(stored) ? stored : {};
  return Object.fromEntries(
    Object.entries(incoming).map(([key, value]) => {
      return [key, restore(value, bag[key])];
    })
  );
};

/** `template` with its placeholders restored from `stored`; pure. */
export const restoreTemplateSecrets = (args: {
  template: unknown;
  stored: unknown;
}): unknown => {
  if (!isPlainObject(args.template) || !isPlainObject(args.template.resources))
    return args.template;
  const storedResources = isPlainObject(args.stored)
    ? args.stored.resources
    : undefined;
  const stored = isPlainObject(storedResources) ? storedResources : {};
  const errors: { path: string; message: string }[] = [];
  const resources = Object.fromEntries(
    Object.entries(args.template.resources).map(([logicalId, declaration]) => {
      if (!holdsPlaceholder(declaration)) return [logicalId, declaration];
      const restored = restore(declaration, stored[logicalId]);
      if (!isDeepStrictEqual(restored, stored[logicalId])) {
        errors.push({
          path: `resources.${logicalId}`,
          message:
            'A resource keeping a masked value ({"no_echo": true}) must equal its deployed declaration; send the value to change it.',
        });
      }
      return [logicalId, restored];
    })
  );
  if (errors.length > 0) {
    throw new DomainError('VALIDATION_FAILED', 'Invalid template', {
      details: errors,
    });
  }
  return { ...args.template, resources };
};

type StoredFormation = { formationId: string | undefined; projectId?: number };

const findStoredFormation = (stored: StoredFormation | undefined) => {
  if (!stored?.formationId) return Promise.resolve(null);
  return db.Formation.findOne({
    where: {
      publicId: stored.formationId,
      status: { [Op.ne]: 'deleted' },
      ...(stored.projectId === undefined
        ? {}
        : { projectId: stored.projectId }),
    },
  });
};

const validTemplate = async (args: {
  input: unknown;
  projectPublicId: string;
  stored?: StoredFormation;
}): Promise<FormationTemplate> => {
  const parsed = parseFormationTemplateInput(args.input);
  const template = holdsPlaceholder(parsed)
    ? restoreTemplateSecrets({
        template: parsed,
        stored: (await findStoredFormation(args.stored))?.template,
      })
    : parsed;
  const validation = await validateFormationTemplateAsync({
    template,
    projectPublicId: args.projectPublicId,
  });
  if (!validation.valid) {
    throw new DomainError('VALIDATION_FAILED', 'Invalid template', {
      details: validation.errors,
    });
  }
  return template as FormationTemplate;
};

// The stored template was accepted when stored; it is not re-validated, so a
// template stored before a rule existed still redeploys.
const storedTemplate = async (
  stored: StoredFormation
): Promise<FormationTemplate> => {
  const formation = await findStoredFormation(stored);
  if (!formation) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Formation '${stored.formationId}' not found.`
    );
  }
  return formation.template as FormationTemplate;
};

/**
 * The template a create, update or plan deploys: parsed, its placeholders
 * restored from `stored` (the formation it redeploys), and valid, or
 * `400 VALIDATION_FAILED`; with no `input`, the template `stored` holds.
 * `parameters` give every parameter it reads a value of its type, or
 * `400 FORMATION_MISSING_PARAMETERS` / `FORMATION_INVALID_PARAMETERS`. A plan
 * previews only what its deploy accepts.
 */
export const deployableTemplate = async (args: {
  input: unknown;
  parameters: Record<string, string> | undefined;
  projectPublicId: string;
  stored?: StoredFormation;
}): Promise<FormationTemplate> => {
  const deployable =
    args.input === undefined && args.stored?.formationId !== undefined
      ? await storedTemplate(args.stored)
      : await validTemplate(args);
  const missing = missingParameterErrors({
    template: deployable,
    provided: args.parameters,
    forUpdate: args.stored?.formationId !== undefined,
  });
  if (missing.length > 0) {
    throw new DomainError(
      'FORMATION_MISSING_PARAMETERS',
      `Missing required parameters: ${missing
        .map((error) => {
          return error.path.slice('parameters.'.length);
        })
        .join(', ')}`,
      { details: missing }
    );
  }
  resolveParameterValues(deployable, args.parameters);
  return deployable;
};

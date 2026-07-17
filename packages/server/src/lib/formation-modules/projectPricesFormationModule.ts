import createDebug from 'debug';

import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  createFormationProjectPrice,
  deleteFormationProjectPrice,
  getFormationProjectPrice,
  updateFormationProjectPrice,
} from '../priceBookFormation';
import {
  normalizePropertyKeys,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:projectPrices');

const SCHEMA_NAME = 'ProjectPriceResourceProperties';
const RESOURCE_LABEL = 'project price';

// ── Property validation ──────────────────────────────────────────────────

const validateProjectPriceProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      {
        path: basePath,
        message: 'Project price `properties` must be an object',
      },
    ];
  }

  const properties = normalizePropertyKeys(args.properties);
  const spec = loadModuleSpec({ schemaName: SCHEMA_NAME });
  const errors: ValidationError[] = [];
  pushUnknownFieldErrors({
    spec,
    resourceLabel: RESOURCE_LABEL,
    properties,
    basePath,
    errors,
  });
  if (!forUpdate) {
    pushRequiredFieldErrors({ spec, properties, basePath, errors });
  }
  pushFieldTypeErrors({ spec, properties, basePath, errors });

  return errors;
};

// Narrows a property to a number, or undefined when absent/other type. The
// OpenAPI type validation above has already rejected wrong-typed values.
const toOptionalNumber = (value: unknown): number | undefined => {
  return typeof value === 'number' ? value : undefined;
};

// ── Module export ────────────────────────────────────────────────────────

export const projectPricesFormationModule: FormationModule = {
  resourceType: 'project_price',

  validateProperties: ({ properties, basePath }) => {
    return validateProjectPriceProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const errors = validateProjectPriceProperties({
      properties: rawProperties,
      basePath: 'resources.<project_price>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    const result = await createFormationProjectPrice({
      projectId,
      provider: properties.provider as string,
      model: properties.model as string,
      component: properties.component as string,
      unit: properties.unit as string,
      // `unit_price` is required by the schema and validated above.
      unitPrice: properties.unit_price as number,
      meterType: toOptionalString(properties.meter_type),
      effectiveFrom: toOptionalString(properties.effective_from),
    });

    log(
      'created project price from formation: projectId=%d priceId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validateProjectPriceProperties({
      properties: rawProperties,
      basePath: 'resources.<project_price>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    await updateFormationProjectPrice({
      id: physicalResourceId,
      provider: toOptionalString(properties.provider),
      model: toOptionalString(properties.model),
      component: toOptionalString(properties.component),
      unit: toOptionalString(properties.unit),
      unitPrice: toOptionalNumber(properties.unit_price),
      meterType: toOptionalString(properties.meter_type),
      effectiveFrom: toOptionalString(properties.effective_from),
    });

    log('updated project price from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteFormationProjectPrice({ id: physicalResourceId });
    log('deleted project price from formation: id=%s', physicalResourceId);
  },

  read: async ({ physicalResourceId }) => {
    const price = await getFormationProjectPrice({ id: physicalResourceId });
    if (!price) return null;
    return {
      provider: price.provider,
      model: price.model,
      component: price.component,
      unit: price.unit,
      unit_price: price.unitPrice,
      meter_type: price.meterType,
      effective_from: price.effectiveFrom.toISOString(),
    };
  },
};

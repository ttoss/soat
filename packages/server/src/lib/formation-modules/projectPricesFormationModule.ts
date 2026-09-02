import {
  createFormationProjectPrice,
  deleteFormationProjectPrice,
  getFormationProjectPrice,
  updateFormationProjectPrice,
} from '../priceBookFormation';
import { toOptionalString } from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

// Narrows a property to a number, or undefined when absent/other type. The
// OpenAPI type validation in the factory has already rejected wrong-typed values.
const toOptionalNumber = (value: unknown): number | undefined => {
  return typeof value === 'number' ? value : undefined;
};

export const projectPricesFormationModule = defineFormationModule({
  resourceType: 'project_price',
  // Prices are the project's own resource, so the probe is the project
  // wildcard SRN the price routes use rather than a per-price one.
  authorization: {
    srnResourceType: '*',
    create: 'projects:ManageProjectPrices',
    update: 'projects:ManageProjectPrices',
    delete: 'projects:ManageProjectPrices',
  },
  resourceLabel: 'project price',

  create: ({ properties, projectId }) => {
    return createFormationProjectPrice({
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
  },

  update: async ({ properties, physicalResourceId }) => {
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
  },

  remove: ({ physicalResourceId }) => {
    return deleteFormationProjectPrice({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getFormationProjectPrice({ id: physicalResourceId });
  },

  // `effective_from` is a Date on the row and an ISO string in the template, so
  // this view is a mapping rather than a plain field selection.
  read: (price) => {
    return {
      provider: price.provider,
      model: price.model,
      component: price.component,
      unit: price.unit,
      unit_price: price.unit_price,
      meter_type: price.meter_type,
      effective_from: price.effective_from.toISOString(),
    };
  },
});

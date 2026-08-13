import {
  createDataset,
  deleteDataset,
  getDataset,
  updateDataset,
} from '../evaluationDatasets';
import {
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

export const datasetsFormationModule = defineFormationModule({
  resourceType: 'dataset',

  create: ({ properties, projectId }) => {
    return createDataset({
      projectId,
      name: properties.name,
      description: toNullableString(properties.description),
    });
  },

  update: ({ properties, physicalResourceId }) => {
    return updateDataset({
      id: physicalResourceId,
      name: toOptionalString(properties.name),
      // Distinguish "omitted" from an explicit null so a template that leaves
      // the nullable `description` out is not treated as clearing it.
      description:
        properties.description === undefined
          ? undefined
          : toNullableString(properties.description),
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteDataset({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getDataset({ id: physicalResourceId });
  },
});

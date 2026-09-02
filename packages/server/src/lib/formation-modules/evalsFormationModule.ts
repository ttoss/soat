import { createEval, deleteEval, getEval, updateEval } from '../evaluations';
import {
  toNullableNumber,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

export const evalsFormationModule = defineFormationModule({
  resourceType: 'eval',
  authorization: {
    srnResourceType: 'eval',
    create: 'evaluations:CreateEval',
    update: 'evaluations:CreateEval',
    delete: 'evaluations:DeleteEval',
  },

  create: ({ properties, projectId }) => {
    return createEval({
      projectId,
      name: properties.name,
      agentId: properties.agent_id,
      datasetId: properties.dataset_id,
      scorers: properties.scorers,
      passThreshold: properties.pass_threshold,
    });
  },

  update: ({ properties, physicalResourceId }) => {
    return updateEval({
      id: physicalResourceId,
      name: toOptionalString(properties.name),
      agentId: toOptionalString(properties.agent_id),
      datasetId: toOptionalString(properties.dataset_id),
      scorers: properties.scorers,
      // Distinguish "omitted" from an explicit null: omitting `pass_threshold`
      // leaves the eval's gate alone, declaring `null` removes it.
      passThreshold:
        properties.pass_threshold === undefined
          ? undefined
          : toNullableNumber(properties.pass_threshold),
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteEval({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getEval({ id: physicalResourceId });
  },
});

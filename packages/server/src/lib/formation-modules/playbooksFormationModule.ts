import {
  createPlaybook,
  deletePlaybook,
  findPlaybookDeletionBlocker,
  getPlaybook,
  updatePlaybook,
} from '../playbooks';
import {
  toNullableArray,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

export const playbooksFormationModule = defineFormationModule({
  resourceType: 'playbook',
  authorization: {
    srnResourceType: 'playbook',
    create: 'playbooks:CreatePlaybook',
    update: 'playbooks:UpdatePlaybook',
    delete: 'playbooks:DeletePlaybook',
  },

  create: ({ properties, projectId, actor }) => {
    return createPlaybook({
      projectId,
      name: properties.name,
      description: toNullableString(properties.description),
      definition: properties.definition,
      policyIds: toNullableArray<string>(properties.policy_ids),
      createdBy: actor.author,
      writer: actor,
    });
  },

  update: ({ properties, physicalResourceId, actor }) => {
    return updatePlaybook({
      id: physicalResourceId,
      name: toOptionalString(properties.name),
      description: toNullableString(properties.description),
      definition: properties.definition,
      policyIds: toNullableArray<string>(properties.policy_ids),
      createdBy: actor.author,
      writer: actor,
    });
  },

  remove: ({ physicalResourceId }) => {
    return deletePlaybook({ id: physicalResourceId });
  },

  deletionBlocker: ({ physicalResourceId }) => {
    return findPlaybookDeletionBlocker({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getPlaybook({ id: physicalResourceId });
  },
});

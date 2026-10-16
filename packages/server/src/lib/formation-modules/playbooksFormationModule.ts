import {
  createPlaybook,
  deletePlaybook,
  findPlaybookDeletionBlocker,
  getPlaybook,
  updatePlaybook,
} from '../playbooks';
import {
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

// The version a deploy writes runs as the deploying credential, not its
// owner's account, so a key's own boundary bounds what the playbook starts.

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
      createdByUserId: actor.userId,
      author: actor,
    });
  },

  update: ({ properties, physicalResourceId, actor }) => {
    return updatePlaybook({
      id: physicalResourceId,
      name: toOptionalString(properties.name),
      description: toNullableString(properties.description),
      definition: properties.definition,
      createdByUserId: actor.userId,
      author: actor,
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

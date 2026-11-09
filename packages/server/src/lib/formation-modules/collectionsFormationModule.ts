import {
  createCollection,
  deleteCollection,
  getCollection,
  updateCollection,
} from '../collections';
import { defineFormationModule } from './defineFormationModule';

export const collectionsFormationModule = defineFormationModule({
  resourceType: 'collection',
  authorization: {
    srnResourceType: 'collection',
    create: 'collections:CreateCollection',
    update: 'collections:UpdateCollection',
    delete: 'collections:DeleteCollection',
  },

  create: ({ properties, projectId }) => {
    return createCollection({
      projectId,
      name: properties.name,
      schema: properties.schema,
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    await updateCollection({
      id: physicalResourceId,
      name: properties.name,
      // A template that drops `schema` states the collection has none.
      schema: properties.schema ?? null,
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteCollection({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getCollection({ id: physicalResourceId });
  },
});

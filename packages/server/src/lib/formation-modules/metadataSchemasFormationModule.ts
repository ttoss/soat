import {
  createMetadataSchema,
  deleteMetadataSchema,
  getMetadataSchema,
  updateMetadataSchema,
} from '../metadataSchemas';
import { defineFormationModule } from './defineFormationModule';

/**
 * A template declares the contract its documents are written against, so the
 * corpus and the rule governing it ship together rather than the rule being an
 * out-of-band step someone remembers after the first bad write.
 */
export const metadataSchemasFormationModule = defineFormationModule({
  resourceType: 'metadata_schema',
  authorization: {
    srnResourceType: 'metadata_schema',
    create: 'metadata-schemas:CreateMetadataSchema',
    update: 'metadata-schemas:UpdateMetadataSchema',
    delete: 'metadata-schemas:DeleteMetadataSchema',
  },

  create: ({ properties, projectId }) => {
    return createMetadataSchema({
      projectId,
      resourceType: properties.resource_type,
      pathPrefix: properties.path_prefix,
      schema: properties.schema,
    });
  },

  // `resource_type` is immutable, so it is not passed: a template that changed
  // it is asking for a different declaration, which is a delete and a create.
  update: async ({ properties, physicalResourceId }) => {
    await updateMetadataSchema({
      id: physicalResourceId,
      pathPrefix: properties.path_prefix,
      schema: properties.schema,
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteMetadataSchema({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getMetadataSchema({ id: physicalResourceId });
  },
});

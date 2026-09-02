import { createQuota, deleteQuota, getQuota, updateQuota } from '../quotas';
import {
  toNullableNumber,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

export const quotasFormationModule = defineFormationModule({
  resourceType: 'quota',
  authorization: {
    srnResourceType: 'quota',
    create: 'quotas:CreateQuota',
    update: 'quotas:UpdateQuota',
    delete: 'quotas:DeleteQuota',
  },

  create: ({ properties, projectId }) => {
    return createQuota({
      projectId,
      scope: properties.scope as string,
      scopeRef: toNullableString(properties.scope_ref) ?? undefined,
      metric: properties.metric as string,
      window: properties.window as string,
      limit: properties.limit,
      mode: toOptionalString(properties.mode) ?? undefined,
      onUnpriced: toOptionalString(properties.on_unpriced) ?? undefined,
    });
  },

  // The immutable fields are passed through rather than dropped so
  // `updateQuota` can reject a changed value — applying only the mutable ones
  // would leave template and enforced cap divergent, reporting success.
  update: async ({ properties, physicalResourceId }) => {
    await updateQuota({
      id: physicalResourceId,
      // `limit` keeps its `?? undefined` because `toNullableNumber` can return
      // null; `toOptionalString` never does, so the string fields need no
      // fallback (adding one would only leave an unreachable branch behind).
      limit: toNullableNumber(properties.limit) ?? undefined,
      mode: toOptionalString(properties.mode),
      onUnpriced: toOptionalString(properties.on_unpriced),
      scope: toOptionalString(properties.scope),
      metric: toOptionalString(properties.metric),
      window: toOptionalString(properties.window),
      // Distinguish "omitted" from an explicit null: only a declared value is
      // asserted against the stored ref, so a template that leaves the nullable
      // `scope_ref` out is not treated as clearing it.
      scopeRef:
        properties.scope_ref === undefined
          ? undefined
          : toNullableString(properties.scope_ref),
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteQuota({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getQuota({ id: physicalResourceId });
  },
});

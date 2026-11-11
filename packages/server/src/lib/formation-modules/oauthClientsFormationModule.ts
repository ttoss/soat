import { isSub } from '../formationsHelpers';
import {
  CLIENT_SECRET_REFERENCE_MESSAGE,
  clientSecretIds,
  createOauthClient,
  deleteOauthClient,
  getOauthClient,
  isClientSecretReference,
  type OauthClientInput,
  updateOauthClient,
} from '../oauthClients';
import {
  toNullableArray,
  toNullableString,
  toNullableStringRecord,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { SECRET_USE_ACTION } from '../secretUse';
import { defineFormationModule } from './defineFormationModule';
import { isObjectRecord } from './formationSpecLoader';

// A `sub` naming a template secret (`{{secret:${MySecret}}}`) becomes a
// reference only at deploy; its `${...}` reads as a secret id here.
const clientSecretAsDeployed = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (isSub(value)) return value.sub.replace(/\$\{[^}]*\}/g, 'sec_deploy');
  return undefined;
};

const readInput = (properties: Record<string, unknown>): OauthClientInput => {
  return {
    name: toOptionalString(properties.name),
    authorizeUrl: toOptionalString(properties.authorize_url),
    tokenUrl: toOptionalString(properties.token_url),
    revocationUrl: toNullableString(properties.revocation_url),
    clientId: toOptionalString(properties.client_id),
    clientSecret: toNullableString(properties.client_secret),
    scopes: toNullableArray<string>(properties.scopes) ?? undefined,
    pkce: typeof properties.pkce === 'boolean' ? properties.pkce : undefined,
    tokenEndpointAuthMethod: toOptionalString(
      properties.token_endpoint_auth_method
    ),
    redirectUri: toNullableString(properties.redirect_uri),
    authorizeParams: toNullableStringRecord(properties.authorize_params),
  };
};

export const oauthClientsFormationModule = defineFormationModule({
  resourceType: 'oauth_client',
  authorization: {
    srnResourceType: 'oauth_client',
    create: 'oauth-clients:CreateOauthClient',
    update: 'oauth-clients:UpdateOauthClient',
    delete: 'oauth-clients:DeleteOauthClient',
    references: (properties) => {
      if (!isObjectRecord(properties)) return [];
      const secret = properties.client_secret;
      return clientSecretIds(typeof secret === 'string' ? secret : null).map(
        (resourceId) => {
          return {
            action: SECRET_USE_ACTION,
            srnResourceType: 'secret',
            resourceId,
          };
        }
      );
    },
  },
  resourceLabel: 'OAuth client',

  extraChecks: ({ properties, basePath, errors }) => {
    const secret = clientSecretAsDeployed(properties.client_secret);
    if (secret !== undefined && !isClientSecretReference(secret)) {
      errors.push({
        path: `${basePath}.client_secret`,
        message: CLIENT_SECRET_REFERENCE_MESSAGE,
      });
    }
  },

  create: ({ properties, projectId, actor }) => {
    const input = readInput(properties);
    return createOauthClient({
      projectId,
      // Required by OauthClientResourceProperties and validated above.
      input: {
        ...input,
        name: properties.name as string,
        authorizeUrl: properties.authorize_url as string,
        tokenUrl: properties.token_url as string,
        clientId: properties.client_id as string,
        scopes: properties.scopes as string[],
      },
      isAllowed: actor.isAllowed,
    });
  },

  update: ({ properties, physicalResourceId, actor }) => {
    return updateOauthClient({
      id: physicalResourceId,
      input: readInput(properties),
      isAllowed: actor.isAllowed,
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteOauthClient({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getOauthClient({ id: physicalResourceId });
  },
});

import createDebug from 'debug';
import { db } from 'src/db';
import { paginatedList } from 'src/lib/pagination';
import { makeResourceAccessor } from 'src/lib/resourceAccessor';

import { DomainError } from '../errors';
import type { IsAllowedFn } from '../middleware/authProjectResolvers';
import { isPlainObject } from './plainObject';
import { projectScopeWhere } from './projectScope';
import { resolveSecretRefsInString, SECRET_ID_PATTERN } from './secrets';
import { assertSecretUseAllowed } from './secretUse';

const log = createDebug('soat:oauth-clients');

export type OauthClientRow = InstanceType<
  (typeof db)['OauthProviderClient']
> & {
  project?: InstanceType<(typeof db)['Project']>;
};

export const oauthClients = makeResourceAccessor<OauthClientRow>({
  model: () => {
    return db.OauthProviderClient;
  },
  includes: () => {
    return [{ model: db.Project, as: 'project' }];
  },
  label: 'OAuth client',
});

const TOKEN_ENDPOINT_AUTH_METHODS = [
  'client_secret_basic',
  'client_secret_post',
] as const;

type TokenEndpointAuthMethod = (typeof TOKEN_ENDPOINT_AUTH_METHODS)[number];

export type OauthClientInput = {
  name?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  revocationUrl?: string | null;
  clientId?: string;
  clientSecret?: string | null;
  scopes?: string[];
  pkce?: boolean;
  tokenEndpointAuthMethod?: string;
  redirectUri?: string | null;
  authorizeParams?: Record<string, string> | null;
};

const SECRET_REFERENCE_RE = new RegExp(
  `^\\{\\{secret:(${SECRET_ID_PATTERN})\\}\\}$`
);

const invalid = (message: string) => {
  return new DomainError('VALIDATION_FAILED', message);
};

export const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
};

const URL_FIELDS = [
  ['authorizeUrl', 'authorize_url'],
  ['tokenUrl', 'token_url'],
  ['revocationUrl', 'revocation_url'],
  ['redirectUri', 'redirect_uri'],
] as const;

const validateUrls = (input: OauthClientInput): void => {
  for (const [key, wire] of URL_FIELDS) {
    const value = input[key];
    if (typeof value === 'string' && !isHttpUrl(value)) {
      throw invalid(`${wire} must be an http(s) URL.`);
    }
  }
};

const validateAuthorizeParams = (value: unknown): void => {
  if (value === null || value === undefined) return;
  const valid =
    isPlainObject(value) &&
    Object.values(value).every((entry) => {
      return typeof entry === 'string';
    });
  if (!valid) throw invalid('authorize_params must map names to strings.');
};

export const CLIENT_SECRET_REFERENCE_MESSAGE =
  'client_secret must be a secret reference ({{secret:sec_...}}), never the value.';

export const isClientSecretReference = (value: string): boolean => {
  return SECRET_REFERENCE_RE.test(value);
};

const validateInput = (input: OauthClientInput): void => {
  validateUrls(input);
  if (
    typeof input.clientSecret === 'string' &&
    !isClientSecretReference(input.clientSecret)
  ) {
    throw invalid(CLIENT_SECRET_REFERENCE_MESSAGE);
  }
  if (
    input.tokenEndpointAuthMethod !== undefined &&
    !(TOKEN_ENDPOINT_AUTH_METHODS as readonly string[]).includes(
      input.tokenEndpointAuthMethod
    )
  ) {
    throw invalid(
      `token_endpoint_auth_method must be one of ${TOKEN_ENDPOINT_AUTH_METHODS.join(', ')}.`
    );
  }
  validateAuthorizeParams(input.authorizeParams);
};

export const clientSecretIds = (
  reference: string | null | undefined
): string[] => {
  const match = reference ? SECRET_REFERENCE_RE.exec(reference) : null;
  return match ? [match[1]] : [];
};

export const mapOauthClient = (row: OauthClientRow) => {
  return {
    id: row.publicId,
    project_id: row.project?.publicId,
    name: row.name,
    authorize_url: row.authorizeUrl,
    token_url: row.tokenUrl,
    revocation_url: row.revocationUrl,
    client_id: row.clientId,
    client_secret: row.clientSecret,
    scopes: row.scopes,
    pkce: row.pkce,
    token_endpoint_auth_method: row.tokenEndpointAuthMethod,
    redirect_uri: row.redirectUri,
    authorize_params: row.authorizeParams,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
};

/** `projectIds` undefined is no project filter (an admin's unscoped read). */
export const listOauthClients = async (args: {
  projectIds?: number[];
  limit?: number;
  cursor?: string;
}) => {
  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: { projectIds: args.projectIds },
    where: projectScopeWhere({ projectIds: args.projectIds }),
    order: [['createdAt', 'ASC']],
    query: ({ where, limit, order }) => {
      return db.OauthProviderClient.findAll({
        where,
        include: [{ model: db.Project, as: 'project' }],
        order,
        limit,
      });
    },
    map: mapOauthClient,
  });
};

export const getOauthClient = async (args: { id: string }) => {
  return mapOauthClient(await oauthClients.getByPublicId({ id: args.id }));
};

export const createOauthClient = async (args: {
  projectId: number;
  input: Required<
    Pick<
      OauthClientInput,
      'name' | 'authorizeUrl' | 'tokenUrl' | 'clientId' | 'scopes'
    >
  > &
    OauthClientInput;
  isAllowed: IsAllowedFn;
}) => {
  log(
    'createOauthClient: projectId=%d name=%s',
    args.projectId,
    args.input.name
  );
  validateInput(args.input);
  await assertSecretUseAllowed({
    secretIds: clientSecretIds(args.input.clientSecret),
    projectId: args.projectId,
    isAllowed: args.isAllowed,
  });
  const row = await db.OauthProviderClient.create({
    projectId: args.projectId,
    ...args.input,
    tokenEndpointAuthMethod:
      args.input.tokenEndpointAuthMethod ?? 'client_secret_basic',
  });
  return mapOauthClient(await oauthClients.reload(row));
};

export const updateOauthClient = async (args: {
  id: string;
  input: OauthClientInput;
  isAllowed: IsAllowedFn;
}) => {
  log('updateOauthClient: id=%s', args.id);
  validateInput(args.input);
  const row = await oauthClients.getByPublicId({ id: args.id });
  await assertSecretUseAllowed({
    secretIds: clientSecretIds(args.input.clientSecret),
    projectId: row.projectId,
    isAllowed: args.isAllowed,
  });
  const changes = Object.fromEntries(
    Object.entries(args.input).filter(([, value]) => {
      return value !== undefined;
    })
  );
  await row.update(changes);
  return mapOauthClient(await oauthClients.reload(row));
};

export const deleteOauthClient = async (args: { id: string }) => {
  log('deleteOauthClient: id=%s', args.id);
  const row = await oauthClients.getByPublicId({ id: args.id });
  await row.destroy();
};

export type ResolvedOauthClient = {
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  clientId: string;
  clientSecret: string | null;
  scopes: string[];
  pkce: boolean;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  redirectUri: string | null;
  authorizeParams: Record<string, string> | null;
};

/** The client with its secret reference resolved, for the server's own use. */
export const resolveOauthClient = async (
  row: OauthClientRow
): Promise<ResolvedOauthClient> => {
  return {
    authorizeUrl: row.authorizeUrl,
    tokenUrl: row.tokenUrl,
    revocationUrl: row.revocationUrl,
    clientId: row.clientId,
    clientSecret: row.clientSecret
      ? await resolveSecretRefsInString({
          value: row.clientSecret,
          projectId: row.projectId,
        })
      : null,
    scopes: row.scopes,
    pkce: row.pkce,
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    redirectUri: row.redirectUri,
    authorizeParams: row.authorizeParams,
  };
};

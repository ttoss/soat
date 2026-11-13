import { API_KEY_RAW_PREFIX } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { hashApiKey } from './apiKeyVerifier';
import { credentialNarrowed } from './authorizationDenial';
import { paginatedList } from './pagination';
import { generateSecretValue } from './secrets';
import { assertWriterHolds, type Writer } from './writerRule';

const log = createDebug('soat:apiKeys');

type ApiKeyWithAssociations = InstanceType<(typeof db)['ApiKey']> & {
  user: InstanceType<(typeof db)['User']> | null;
  project: InstanceType<(typeof db)['Project']> | null;
};

const mapApiKey = (apiKey: InstanceType<(typeof db)['ApiKey']>) => {
  return {
    id: apiKey.publicId,
    name: apiKey.name,
    key_prefix: apiKey.keyPrefix,
    created_at: apiKey.createdAt,
    updated_at: apiKey.updatedAt,
  };
};

const mapApiKeyWithAssociations = (apiKey: ApiKeyWithAssociations) => {
  /* projectId is null for unscoped keys, and the association is also null if the
   * project row was removed; expose null as project_id in both cases. */
  return {
    ...mapApiKey(apiKey),
    user_id: apiKey.user?.publicId ?? null,
    project_id: apiKey.project?.publicId ?? null,
    policy_ids: apiKey.policyIds,
  };
};

/**
 * Whether a key write may store `requestedPolicyIds` when the caller is itself
 * an API key narrowed by `boundaryPolicyIds`: only a non-empty subset of that
 * boundary, so a narrowed key never writes a key wider than itself. An omitted
 * list inherits the boundary when `inheritWhenOmitted` (create) and stays
 * unchanged otherwise (update).
 */
const resolveKeyPolicyBoundary = (args: {
  boundaryPolicyIds: string[] | undefined;
  requestedPolicyIds: string[] | undefined;
  inheritWhenOmitted: boolean;
}): { allowed: boolean; policyIds: string[] | undefined } => {
  const { boundaryPolicyIds, requestedPolicyIds } = args;
  if (!boundaryPolicyIds || boundaryPolicyIds.length === 0) {
    return { allowed: true, policyIds: requestedPolicyIds };
  }
  if (requestedPolicyIds === undefined) {
    return {
      allowed: true,
      policyIds: args.inheritWhenOmitted ? boundaryPolicyIds : undefined,
    };
  }
  const allowed =
    requestedPolicyIds.length > 0 &&
    requestedPolicyIds.every((id) => {
      return boundaryPolicyIds.includes(id);
    });
  log(
    'resolveKeyPolicyBoundary: allowed=%s requested=%o',
    allowed,
    requestedPolicyIds
  );
  return { allowed, policyIds: requestedPolicyIds };
};

/**
 * `policyIds` once the writer is shown to hold them; `undefined` when the
 * write omits them.
 */
export const heldKeyPolicyIds = async (args: {
  policyIds: string[] | undefined;
  writer: Writer;
  projectId: number | null;
}): Promise<string[] | undefined> => {
  if (args.policyIds === undefined) return undefined;
  await assertWriterHolds({
    carrier: 'apiKeys',
    writer: args.writer,
    projectId: args.projectId,
    carried: { policyIds: args.policyIds },
  });
  return args.policyIds;
};

/**
 * The one boundary check every key write runs — `POST`/`PUT /api-keys` and the
 * `api_key` formation module. Returns the `policy_ids` to store. A request
 * narrowed beyond its key's own `policy_ids` is refused outright
 * (`CREDENTIAL_NARROWED`): a key cannot carry that narrowing, so it would
 * outlive it. `onRefused` runs first: the refusal precedes any `isAllowed`
 * call, so the audit wrapper would otherwise never see it.
 */
export const boundKeyPolicyIds = (args: {
  narrowed: boolean;
  boundaryPolicyIds: string[] | undefined;
  requestedPolicyIds: string[] | undefined;
  inheritWhenOmitted: boolean;
  onRefused: () => void;
}): string[] | undefined => {
  if (args.narrowed) {
    args.onRefused();
    throw credentialNarrowed({ writing: 'an API key' });
  }

  const boundary = resolveKeyPolicyBoundary(args);
  if (boundary.allowed) return boundary.policyIds;

  args.onRefused();
  // Meta keys are snake_case to match the external REST contract.
  throw new DomainError(
    'API_KEY_POLICY_BOUNDARY',
    'This API key is narrowed by policy_ids and cannot write a key outside ' +
      'that boundary. Name a non-empty subset of its policy_ids.',
    {
      boundary_policy_ids: args.boundaryPolicyIds ?? [],
      requested_policy_ids: args.requestedPolicyIds ?? [],
    }
  );
};

export const createApiKey = async (args: {
  userId: number;
  name: string;
  /** Omit or pass null to create an unscoped key that spans projects. */
  projectId?: number | null;
  policyIds?: string[];
}) => {
  const random = generateSecretValue();
  const key = `${API_KEY_RAW_PREFIX}${random}`;
  const keyPrefix = key.slice(0, 8);

  const apiKey = await db.ApiKey.create({
    userId: args.userId,
    name: args.name,
    projectId: args.projectId ?? null,
    policyIds: args.policyIds ?? [],
    keyPrefix,
    keyHashSha256: hashApiKey({ rawKey: key }),
  });

  /* The spec's `ApiKeyCreated` is `allOf[ApiKeyRecord, {key}]`, so create owes
   * the same scope fields `GET`/`LIST` return — and it is the only response that
   * ever carries the raw key, so it is the only chance the caller has to confirm
   * what it just minted. Reloading the associations (rather than spreading the
   * bare `mapApiKey`) is what makes `project_id` an explicit `null` for an
   * unscoped key instead of an absent field indistinguishable from one. */
  await apiKey.reload({
    include: [
      { model: db.User, as: 'user' },
      { model: db.Project, as: 'project' },
    ],
  });

  return {
    ...mapApiKeyWithAssociations(apiKey as ApiKeyWithAssociations),
    key, // Return the full key only once at creation
  };
};

export const getApiKey = async (args: { id: string }) => {
  const apiKey = await db.ApiKey.findOne({
    where: { publicId: args.id },
    include: [
      { model: db.User, as: 'user' },
      { model: db.Project, as: 'project' },
    ],
  });

  if (!apiKey) {
    return null;
  }

  return mapApiKeyWithAssociations(apiKey as ApiKeyWithAssociations);
};

export const updateApiKey = async (args: {
  id: string;
  name?: string;
  /**
   * `undefined` leaves the scope unchanged; `null` clears it (unscoped key); a
   * number re-scopes the key to that project.
   */
  projectId?: number | null;
  policyIds?: string[];
}) => {
  const apiKey = await db.ApiKey.findOne({
    where: { publicId: args.id },
  });

  if (!apiKey) {
    return null;
  }

  const updates: Record<string, unknown> = {};
  if (args.name !== undefined) updates.name = args.name;
  if (args.projectId !== undefined) updates.projectId = args.projectId;
  if (args.policyIds !== undefined) updates.policyIds = args.policyIds;

  await apiKey.update(updates);

  return getApiKey({ id: args.id });
};

export const listApiKeys = async (args: {
  userId?: number;
  projectId?: number;
  limit?: number;
  cursor?: string;
}) => {
  const where: Record<string, unknown> = {};

  if (args.userId !== undefined) {
    where.userId = args.userId;
  }

  if (args.projectId !== undefined) {
    where.projectId = args.projectId;
  }

  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: { userId: args.userId, projectId: args.projectId },
    where: Object.keys(where).length > 0 ? where : undefined,
    order: [['createdAt', 'DESC']],
    query: ({ where: pageWhere, limit, order }) => {
      return db.ApiKey.findAll({
        where: pageWhere,
        include: [
          { model: db.User, as: 'user' },
          { model: db.Project, as: 'project' },
        ],
        order,
        limit,
      });
    },
    map: (apiKey) => {
      return mapApiKeyWithAssociations(apiKey as ApiKeyWithAssociations);
    },
  });
};

export const deleteApiKey = async (args: { id: string }) => {
  const apiKey = await db.ApiKey.findOne({
    where: { publicId: args.id },
  });

  if (!apiKey) {
    return null;
  }

  await apiKey.destroy();
  return true;
};

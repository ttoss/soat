import crypto from 'node:crypto';

import createDebug from 'debug';
import { db } from 'src/db';
import { paginatedList } from 'src/lib/pagination';
import { makeResourceAccessor } from 'src/lib/resourceAccessor';

import { DomainError } from '../errors';

const log = createDebug('soat:secrets');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

const getEncryptionKey = () => {
  const key = process.env.SECRETS_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('SECRETS_ENCRYPTION_KEY environment variable is not set');
  }
  const buf = Buffer.from(key, 'hex');
  if (buf.length !== 32) {
    throw new Error(
      'SECRETS_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)'
    );
  }
  return buf;
};

export const encryptValue = (plaintext: string): string => {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
};

export const decryptValue = (ciphertext: string): string => {
  const key = getEncryptionKey();
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
};

/**
 * A 32-byte random value, hex-encoded. The shared source for every
 * server-minted secret (trigger secrets, webhook secrets, API keys).
 */
export const generateSecretValue = (): string => {
  return crypto.randomBytes(32).toString('hex');
};

/**
 * Decrypts a stored trigger / webhook secret, refusing a value that is not
 * valid ciphertext. There is no plaintext fallback for pre-encryption rows: a
 * secret is either encrypted or refused.
 *
 * The refusal is a named error rather than the raw `unable to authenticate
 * data`, because the two causes an operator must tell apart both land here — a
 * row predating encryption (rotate it) and a changed `SECRETS_ENCRYPTION_KEY`
 * (restore the key; rotating discards every other secret under the old one).
 * The stored value is never in the message: it may *be* the plaintext secret.
 */
export const decryptStoredSecret = (args: {
  stored: string;
  label: string;
}): string => {
  try {
    return decryptValue(args.stored);
  } catch {
    log('%s: stored value could not be decrypted', args.label);
    throw new DomainError(
      'SECRET_NOT_DECRYPTABLE',
      'The stored secret could not be decrypted: it was encrypted under a different SECRETS_ENCRYPTION_KEY. Rotate the secret to replace it, or restore the original key.'
    );
  }
};

type SecretRow = InstanceType<(typeof db)['Secret']> & {
  project?: InstanceType<(typeof db)['Project']>;
};

const secretIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

const secrets = makeResourceAccessor<SecretRow>({
  model: () => {
    return db.Secret;
  },
  includes: secretIncludes,
  label: 'Secret',
});

const mapSecret = (instance: SecretRow) => {
  return {
    id: instance.publicId,
    project_id: instance.project?.publicId,
    name: instance.name,
    has_value: instance.encryptedValue !== null,
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
};

export const listSecrets = async (args: {
  projectIds: number[];
  limit?: number;
  offset?: number;
}) => {
  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Secret.findAndCountAll({
        where: { projectId: args.projectIds },
        include: [{ model: db.Project, as: 'project' }],
        distinct: true,
        limit,
        offset,
      });
    },
    map: mapSecret,
  });
};

export const getSecret = async (args: { id: string }) => {
  return mapSecret(await secrets.getByPublicId({ id: args.id }));
};

export const createSecret = async (args: {
  projectId: number;
  name: string;
  value: string;
}) => {
  const secret = await db.Secret.create({
    projectId: args.projectId,
    name: args.name,
    encryptedValue: encryptValue(args.value),
  });
  return mapSecret(await secrets.reload(secret));
};

export const updateSecret = async (args: {
  id: string;
  name?: string;
  value?: string;
}) => {
  const secret = await db.Secret.findOne({
    where: { publicId: args.id },
    include: [{ model: db.Project, as: 'project' }],
  });
  if (!secret)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Secret '${args.id}' not found.`
    );

  if (args.name !== undefined) {
    secret.name = args.name;
  }
  if (args.value !== undefined) {
    secret.encryptedValue = encryptValue(args.value);
  }
  await secret.save();
  return mapSecret(secret);
};

// Any string-valued input may embed a `{{secret:<publicId>}}` token. The token
// is what gets stored and echoed back; it resolves to the decrypted value
// server-side at the point of use only.

const SECRET_REF_RE = /\{\{secret:(sec_[A-Za-z0-9]+)\}\}/g;

/**
 * Collects the public IDs of all secrets referenced by `{{secret:...}}`
 * tokens anywhere inside a value (deep-walks strings, arrays, and objects).
 */
const collectSecretRefs = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return [...value.matchAll(SECRET_REF_RE)].map((m) => {
      return m[1];
    });
  }
  if (Array.isArray(value)) return value.flatMap(collectSecretRefs);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(
      collectSecretRefs
    );
  }
  return [];
};

const loadReferencedSecrets = async (args: {
  ids: string[];
  projectId: number;
}): Promise<Map<string, InstanceType<(typeof db)['Secret']>>> => {
  if (args.ids.length === 0) return new Map();
  const secrets = await db.Secret.findAll({
    where: { publicId: args.ids, projectId: args.projectId },
  });
  const byId = new Map(
    secrets.map((s) => {
      return [s.publicId, s];
    })
  );
  const missing = args.ids.find((id) => {
    return !byId.has(id);
  });
  if (missing) {
    throw new DomainError(
      'SECRET_NOT_FOUND',
      `Secret '${missing}' referenced by a {{secret:...}} token does not exist in this project.`,
      { secretId: missing }
    );
  }
  return byId;
};

/**
 * Validates that every `{{secret:...}}` token inside a value references a
 * secret that exists in the given project. Throws `SECRET_NOT_FOUND` (400)
 * otherwise. Use at create/update time to fail fast instead of at first call.
 */
export const assertSecretRefsExist = async (args: {
  value: unknown;
  projectId: number;
}): Promise<void> => {
  const ids = [...new Set(collectSecretRefs(args.value))];
  if (ids.length === 0) return;
  log(
    'assertSecretRefsExist: projectId=%d refs=%d',
    args.projectId,
    ids.length
  );
  await loadReferencedSecrets({ ids, projectId: args.projectId });
};

/**
 * Loads and decrypts every secret referenced by a `{{secret:...}}` token
 * anywhere inside a value, keyed by public id. Throws `SECRET_NOT_FOUND` for a
 * token referencing a nonexistent or out-of-project secret.
 *
 * Exposed so `toolTemplates.ts` can substitute secret and `{{context:...}}`
 * tokens in a single pass — resolving them in two sequential passes would make
 * whichever ran second treat the other's substituted value as template source.
 * Never log or persist the returned values.
 */
export const loadSecretValues = async (args: {
  value: unknown;
  projectId: number;
}): Promise<Map<string, string>> => {
  const ids = [...new Set(collectSecretRefs(args.value))];
  if (ids.length === 0) return new Map();
  log('loadSecretValues: projectId=%d refs=%d', args.projectId, ids.length);
  const byId = await loadReferencedSecrets({ ids, projectId: args.projectId });
  const values = new Map<string, string>();
  for (const [id, secret] of byId) {
    if (secret.encryptedValue) {
      values.set(id, decryptValue(secret.encryptedValue));
    }
  }
  return values;
};

/**
 * Resolves every `{{secret:...}}` token in a string to the decrypted value
 * of the referenced secret, scoped to the given project. Throws
 * `SECRET_NOT_FOUND` for a token referencing a nonexistent or out-of-project
 * secret. Never log or persist the returned value.
 */
export const resolveSecretRefsInString = async (args: {
  value: string;
  projectId: number;
}): Promise<string> => {
  const ids = [...new Set(collectSecretRefs(args.value))];
  if (ids.length === 0) return args.value;
  log(
    'resolveSecretRefsInString: projectId=%d refs=%d',
    args.projectId,
    ids.length
  );
  const byId = await loadReferencedSecrets({ ids, projectId: args.projectId });
  return args.value.replace(SECRET_REF_RE, (original, secretId: string) => {
    const secret = byId.get(secretId);
    if (!secret?.encryptedValue) return original;
    return decryptValue(secret.encryptedValue);
  });
};

export const deleteSecret = async (args: {
  id: string;
  force?: boolean;
}): Promise<void> => {
  const secret = await db.Secret.findOne({ where: { publicId: args.id } });
  if (!secret)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Secret '${args.id}' not found.`
    );

  const dependentCount = await db.AiProvider.count({
    where: { secretId: secret.id },
  });

  if (dependentCount > 0 && !args.force) {
    throw new DomainError(
      'SECRET_HAS_DEPENDENTS',
      `Secret '${args.id}' is in use by ${dependentCount} AI provider(s) and cannot be deleted without force.`,
      { dependentCount }
    );
  }

  if (args.force) {
    await db.AiProvider.destroy({ where: { secretId: secret.id } });
  }

  await secret.destroy();
};

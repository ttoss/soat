import crypto from 'node:crypto';

import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { collectTokens, renderRecord, renderTemplate } from './templating';

const log = createDebug('soat:secrets');

const SECRET_NAMESPACE = 'secret';

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

const mapSecret = (
  instance: InstanceType<(typeof db)['Secret']> & {
    project?: InstanceType<(typeof db)['Project']>;
  }
) => {
  return {
    id: instance.publicId,
    projectId: instance.project?.publicId,
    name: instance.name,
    hasValue: instance.encryptedValue !== null,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
};

export const listSecrets = async (args: { projectIds: number[] }) => {
  const secrets = await db.Secret.findAll({
    where: { projectId: args.projectIds },
    include: [{ model: db.Project, as: 'project' }],
  });
  return secrets.map(mapSecret);
};

export const getSecret = async (args: { id: string }) => {
  const secret = await db.Secret.findOne({
    where: { publicId: args.id },
    include: [{ model: db.Project, as: 'project' }],
  });
  if (!secret)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Secret '${args.id}' not found.`
    );
  return mapSecret(secret);
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
  const withProject = await db.Secret.findOne({
    where: { id: secret.id },
    include: [{ model: db.Project, as: 'project' }],
  });
  return mapSecret(withProject!);
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

// ── Secret references (${secret.sec_...}) ─────────────────────────────────
//
// Any string-valued input across the API may embed a `${secret.<publicId>}`
// token. The token is what gets stored and echoed back by GET/LIST endpoints;
// it is resolved to the decrypted value server-side, at the point of use only
// (e.g. right before an outbound fetch for an http tool). Resolution runs
// through the shared string-template engine — the `secret` namespace is the
// only reserved namespace here, so other namespaces (`${arg.*}`) are left
// intact for their own stage.

/**
 * Collects the public IDs of all secrets referenced by `${secret.<id>}` tokens
 * anywhere inside a value (deep-walks strings, arrays, and objects).
 */
export const collectSecretRefs = (value: unknown): string[] => {
  return collectTokens(value)
    .filter((token) => {
      return token.namespace === SECRET_NAMESPACE;
    })
    .map((token) => {
      return token.path;
    });
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
      `Secret '${missing}' referenced by a \${secret.<id>} token does not exist in this project.`,
      { secretId: missing }
    );
  }
  return byId;
};

/**
 * Validates that every `${secret.<id>}` token inside a value references a
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
 * Builds a synchronous `secret` resolver by pre-loading every secret an
 * already-collected id list references. A token whose secret has no stored
 * value resolves to `undefined`, which leaves the token verbatim (unchanged
 * from the prior behavior).
 */
const buildSecretResolver = async (args: {
  ids: string[];
  projectId: number;
}): Promise<(id: string) => string | undefined> => {
  const byId = await loadReferencedSecrets({
    ids: [...new Set(args.ids)],
    projectId: args.projectId,
  });
  return (id: string) => {
    const secret = byId.get(id);
    return secret?.encryptedValue
      ? decryptValue(secret.encryptedValue)
      : undefined;
  };
};

/**
 * Resolves every `${secret.<id>}` token in a string to the decrypted value of
 * the referenced secret, scoped to the given project. Throws
 * `SECRET_NOT_FOUND` for a token referencing a nonexistent or out-of-project
 * secret. Never log or persist the returned value.
 */
export const resolveSecretRefsInString = async (args: {
  value: string;
  projectId: number;
}): Promise<string> => {
  const ids = collectSecretRefs(args.value);
  if (ids.length === 0) return args.value;
  log(
    'resolveSecretRefsInString: projectId=%d refs=%d',
    args.projectId,
    ids.length
  );
  const secret = await buildSecretResolver({ ids, projectId: args.projectId });
  return renderTemplate(args.value, { resolvers: { secret } }).output;
};

/**
 * Resolves `${secret.<id>}` tokens in every value of a headers-shaped record.
 */
export const resolveSecretRefsInRecord = async (args: {
  record: Record<string, string> | undefined;
  projectId: number;
}): Promise<Record<string, string> | undefined> => {
  if (!args.record) return args.record;
  const ids = collectSecretRefs(args.record);
  if (ids.length === 0) return args.record;
  const secret = await buildSecretResolver({ ids, projectId: args.projectId });
  return renderRecord(args.record, { resolvers: { secret } }).output;
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

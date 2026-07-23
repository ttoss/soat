import crypto from 'node:crypto';

import createDebug from 'debug';
import { db } from 'src/db';
import { paginatedList } from 'src/lib/pagination';

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

// ── Secret references ({{secret:sec_...}}) ────────────────────────────────
//
// Any string-valued input across the API may embed a `{{secret:<publicId>}}`
// token. The token is what gets stored and echoed back by GET/LIST endpoints;
// it is resolved to the decrypted value server-side, at the point of use only
// (e.g. right before an outbound fetch for an http tool).

const SECRET_REF_RE = /\{\{secret:(sec_[A-Za-z0-9]+)\}\}/g;

/**
 * Collects the public IDs of all secrets referenced by `{{secret:...}}`
 * tokens anywhere inside a value (deep-walks strings, arrays, and objects).
 */
export const collectSecretRefs = (value: unknown): string[] => {
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

// The inner alternation lets a `${...}` sub placeholder's own closing brace
// pass through without prematurely ending the `{{...}}` match — a plain
// `[^}]*` body would stop at the sub's inner `}` and leave a mangled,
// one-brace-short capture for `{{secret:${ApiSecret}}}`.
const DOUBLE_CURLY_RE = /\{\{((?:[^{}]|\$\{[^}]*\})*)\}\}/g;
// A resolved reference (`secret:sec_...`) or a formation `sub` placeholder
// still awaiting resolution (`secret:${LogicalIdOrParam}`) are both valid —
// a formation template is statically validated *before* `${...}` tokens
// resolve, so `{ "sub": "Bearer {{secret:${ApiSecret}}}" }` is legitimate
// template source, not an authoring mistake (see the "Composition" section
// of the expressions & templating reference doc).
const VALID_SECRET_TOKEN_RE = /^secret:(sec_[A-Za-z0-9]+|\$\{[^}]+\})$/;

/**
 * Collects every `{{...}}` token inside a value (deep-walks strings, arrays,
 * and objects) whose content is not a well-formed `secret:sec_...` reference
 * (or an unresolved `secret:${...}` sub placeholder). Double curly braces are
 * reserved exclusively for secret references — this is a shape check only
 * (whether the referenced secret exists is {@link assertSecretRefsExist}'s
 * job), so it needs no DB access and is safe to call from pure, static
 * validation (e.g. `validate-formation`).
 */
export const findInvalidTemplateTokens = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return [...value.matchAll(DOUBLE_CURLY_RE)]
      .map((m) => {
        return m[0];
      })
      .filter((token) => {
        return !VALID_SECRET_TOKEN_RE.test(token.slice(2, -2));
      });
  }
  if (Array.isArray(value)) return value.flatMap(findInvalidTemplateTokens);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(
      findInvalidTemplateTokens
    );
  }
  return [];
};

/**
 * Throws `INVALID_TEMPLATE_TOKEN` (400) when `value` contains a `{{...}}`
 * token that is not a `{{secret:sec_...}}` reference — e.g. a `{{param}}`
 * placeholder copied from another templating system, which the URL/header
 * resolver would otherwise leave with stray braces in the outbound request.
 */
export const assertNoInvalidTemplateTokens = (value: unknown): void => {
  const invalid = [...new Set(findInvalidTemplateTokens(value))];
  if (invalid.length === 0) return;
  throw new DomainError(
    'INVALID_TEMPLATE_TOKEN',
    `Invalid template token(s) ${invalid
      .map((t) => {
        return `'${t}'`;
      })
      .join(
        ', '
      )} — double curly braces are reserved for {{secret:sec_...}} references; use single braces ({param}) for URL path parameters.`,
    { tokens: invalid }
  );
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

/**
 * Resolves `{{secret:...}}` tokens in every value of a headers-shaped record.
 */
export const resolveSecretRefsInRecord = async (args: {
  record: Record<string, string> | undefined;
  projectId: number;
}): Promise<Record<string, string> | undefined> => {
  if (!args.record) return args.record;
  const entries = await Promise.all(
    Object.entries(args.record).map(
      async ([key, value]): Promise<[string, string]> => {
        if (typeof value !== 'string') return [key, value];
        return [
          key,
          await resolveSecretRefsInString({ value, projectId: args.projectId }),
        ];
      }
    )
  );
  return Object.fromEntries(entries);
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

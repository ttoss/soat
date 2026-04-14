import crypto from 'node:crypto';

import { db } from 'src/db';

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
  if (!secret) return null;
  return mapSecret(secret);
};

export const createSecret = async (args: {
  projectId: number;
  name: string;
  value?: string;
}) => {
  const secret = await db.Secret.create({
    projectId: args.projectId,
    name: args.name,
    encryptedValue: args.value ? encryptValue(args.value) : null,
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
  if (!secret) return null;

  if (args.name !== undefined) {
    secret.name = args.name;
  }
  if (args.value !== undefined) {
    secret.encryptedValue = encryptValue(args.value);
  }
  await secret.save();
  return mapSecret(secret);
};

export const deleteSecret = async (args: { id: string; force?: boolean }) => {
  const secret = await db.Secret.findOne({ where: { publicId: args.id } });
  if (!secret) return null;

  const dependentCount = await db.AiProvider.count({
    where: { secretId: secret.id },
  });

  if (dependentCount > 0 && !args.force) {
    return 'conflict' as const;
  }

  if (args.force) {
    await db.AiProvider.destroy({ where: { secretId: secret.id } });
  }

  await secret.destroy();
  return 'deleted' as const;
};

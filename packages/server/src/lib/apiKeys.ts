import crypto from 'node:crypto';

import { API_KEY_RAW_PREFIX } from '@soat/postgresdb';
import bcrypt from 'bcryptjs';

import { db } from '../db';

type ApiKeyWithAssociations = InstanceType<(typeof db)['ApiKey']> & {
  user: InstanceType<(typeof db)['User']> | null;
  project: InstanceType<(typeof db)['Project']> | null;
};

const mapApiKey = (apiKey: InstanceType<(typeof db)['ApiKey']>) => {
  return {
    id: apiKey.publicId,
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    createdAt: apiKey.createdAt,
    updatedAt: apiKey.updatedAt,
  };
};

const mapApiKeyWithAssociations = async (
  apiKey: ApiKeyWithAssociations
): Promise<{
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: Date;
  updatedAt: Date;
  userId: string | null;
  projectId: string | null;
  policyIds: string[];
}> => {
  const policyPublicIds: string[] = [];
  const storedPolicyIds = apiKey.policyIds as number[];
  if (storedPolicyIds && storedPolicyIds.length > 0) {
    const policies = await db.Policy.findAll({
      where: { id: storedPolicyIds },
    });
    policyPublicIds.push(
      ...policies.map((p: InstanceType<(typeof db)['Policy']>) => {
        return p.publicId as string;
      })
    );
  }

  return {
    ...mapApiKey(apiKey),
    userId: apiKey.user?.publicId ?? null,
    projectId: apiKey.project?.publicId ?? null,
    policyIds: policyPublicIds,
  };
};

export const createApiKey = async (args: {
  userId: number;
  name: string;
  projectId?: number;
  policyIds?: number[];
}) => {
  const random = crypto.randomBytes(32).toString('hex');
  const key = `${API_KEY_RAW_PREFIX}${random}`;
  const keyPrefix = key.slice(0, 8);
  const keyHash = await bcrypt.hash(key, 10);

  const apiKey = await db.ApiKey.create({
    userId: args.userId,
    name: args.name,
    projectId: args.projectId ?? null,
    policyIds: args.policyIds ?? [],
    keyPrefix,
    keyHash,
  });

  return {
    ...mapApiKey(apiKey),
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
  projectId?: number | null;
  policyIds?: number[];
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
}) => {
  const where: Record<string, unknown> = {};

  if (args.userId !== undefined) {
    where.userId = args.userId;
  }

  if (args.projectId !== undefined) {
    where.projectId = args.projectId;
  }

  const apiKeys = await db.ApiKey.findAll({
    where: Object.keys(where).length > 0 ? where : undefined,
    include: [
      { model: db.User, as: 'user' },
      { model: db.Project, as: 'project' },
    ],
    order: [['createdAt', 'DESC']],
  });

  return Promise.all(
    (apiKeys as ApiKeyWithAssociations[]).map(mapApiKeyWithAssociations)
  );
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

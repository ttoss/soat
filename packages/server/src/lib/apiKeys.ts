import crypto from 'node:crypto';

import { API_KEY_RAW_PREFIX } from '@soat/postgresdb';
import bcrypt from 'bcryptjs';

import { db } from '../db';

const mapApiKey = (apiKey: InstanceType<(typeof db)['ApiKey']>) => {
  return {
    id: apiKey.publicId,
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    createdAt: apiKey.createdAt,
    updatedAt: apiKey.updatedAt,
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keyUser = (apiKey as any).user;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keyProject = (apiKey as any).project;

  return {
    ...mapApiKey(apiKey),
    userId: keyUser?.publicId ?? null,
    projectId: keyProject?.publicId ?? null,
    policyIds: policyPublicIds,
  };
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

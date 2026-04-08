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
  projectId: number;
  policyId: number;
  name: string;
}) => {
  const random = crypto.randomBytes(32).toString('hex');
  const key = `${API_KEY_RAW_PREFIX}${random}`;
  const keyPrefix = key.slice(0, 8);
  const keyHash = await bcrypt.hash(key, 10);

  const apiKey = await db.ApiKey.create({
    ...args,
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
      { model: db.ProjectPolicy, as: 'policy' },
    ],
  });

  if (!apiKey) {
    return null;
  }

  return {
    ...mapApiKey(apiKey),
    userId: apiKey.user?.publicId,
    projectId: apiKey.project?.publicId,
    policyId: apiKey.policy?.publicId,
  };
};

export const updateApiKey = async (args: { id: string; policyId: number }) => {
  const apiKey = await db.ApiKey.findOne({
    where: { publicId: args.id },
  });

  if (!apiKey) {
    return null;
  }

  await apiKey.update({ policyId: args.policyId });

  return getApiKey({ id: args.id });
};

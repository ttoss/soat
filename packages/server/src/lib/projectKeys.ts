import crypto from 'node:crypto';

import { PROJECT_KEY_RAW_PREFIX } from '@soat/postgresdb';
import bcrypt from 'bcryptjs';

import { db } from '../db';

const mapProjectKey = (projectKey: InstanceType<(typeof db)['ProjectKey']>) => {
  return {
    id: projectKey.publicId,
    name: projectKey.name,
    keyPrefix: projectKey.keyPrefix,
    createdAt: projectKey.createdAt,
    updatedAt: projectKey.updatedAt,
  };
};

export const createProjectKey = async (args: {
  userId: number;
  projectId: number;
  policyId: number;
  name: string;
}) => {
  const random = crypto.randomBytes(32).toString('hex');
  const key = `${PROJECT_KEY_RAW_PREFIX}${random}`;
  const keyPrefix = key.slice(0, 8);
  const keyHash = await bcrypt.hash(key, 10);

  const projectKey = await db.ProjectKey.create({
    ...args,
    keyPrefix,
    keyHash,
  });

  return {
    ...mapProjectKey(projectKey),
    key, // Return the full key only once at creation
  };
};

export const getProjectKey = async (args: { id: string }) => {
  const projectKey = await db.ProjectKey.findOne({
    where: { publicId: args.id },
    include: [
      { model: db.User, as: 'user' },
      { model: db.Project, as: 'project' },
      { model: db.ProjectPolicy, as: 'policy' },
    ],
  });

  if (!projectKey) {
    return null;
  }

  return {
    ...mapProjectKey(projectKey),
    userId: projectKey.user?.publicId,
    projectId: projectKey.project?.publicId,
    policyId: projectKey.policy?.publicId,
  };
};

export const updateProjectKey = async (args: {
  id: string;
  policyId: number;
}) => {
  const projectKey = await db.ProjectKey.findOne({
    where: { publicId: args.id },
  });

  if (!projectKey) {
    return null;
  }

  await projectKey.update({ policyId: args.policyId });

  return getProjectKey({ id: args.id });
};

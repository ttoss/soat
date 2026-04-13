import type { AiProviderSlug } from '@soat/postgresdb';

import { db } from 'src/db';
import { decryptValue } from 'src/lib/secrets';

const getAiProviderIncludes = () => [
  { model: db.Project, as: 'project' },
  { model: db.Secret, as: 'secret' },
];

const mapAiProvider = (
  instance: InstanceType<(typeof db)['AiProvider']> & {
    project?: InstanceType<(typeof db)['Project']>;
    secret?: InstanceType<(typeof db)['Secret']> | null;
  }
) => ({
  id: instance.publicId,
  projectId: instance.project?.publicId,
  secretId: instance.secret?.publicId ?? null,
  name: instance.name,
  provider: instance.provider,
  defaultModel: instance.defaultModel,
  baseUrl: instance.baseUrl ?? undefined,
  config: instance.config ?? undefined,
  createdAt: instance.createdAt,
  updatedAt: instance.updatedAt,
});

export const listAiProviders = async (args: { projectIds: number[] }) => {
  const providers = await db.AiProvider.findAll({
    where: { projectId: args.projectIds },
    include: getAiProviderIncludes(),
  });
  return providers.map(mapAiProvider);
};

export const getAiProvider = async (args: { id: string }) => {
  const provider = await db.AiProvider.findOne({
    where: { publicId: args.id },
    include: getAiProviderIncludes(),
  });
  if (!provider) return null;
  return mapAiProvider(provider);
};

export const createAiProvider = async (args: {
  projectId: number;
  secretId?: number;
  name: string;
  provider: AiProviderSlug;
  defaultModel: string;
  baseUrl?: string;
  config?: Record<string, unknown>;
}) => {
  const instance = await db.AiProvider.create({
    projectId: args.projectId,
    secretId: args.secretId ?? null,
    name: args.name,
    provider: args.provider,
    defaultModel: args.defaultModel,
    baseUrl: args.baseUrl ?? null,
    config: args.config ?? null,
  });
  const withAssociations = await db.AiProvider.findOne({
    where: { id: instance.id },
    include: getAiProviderIncludes(),
  });
  return mapAiProvider(withAssociations!);
};

export const updateAiProvider = async (args: {
  id: string;
  secretId?: number;
  name?: string;
  provider?: AiProviderSlug;
  defaultModel?: string;
  baseUrl?: string | null;
  config?: Record<string, unknown> | null;
}) => {
  const instance = await db.AiProvider.findOne({
    where: { publicId: args.id },
    include: getAiProviderIncludes(),
  });
  if (!instance) return null;

  if (args.name !== undefined) instance.name = args.name;
  if (args.provider !== undefined) instance.provider = args.provider;
  if (args.defaultModel !== undefined)
    instance.defaultModel = args.defaultModel;
  if (args.baseUrl !== undefined) instance.baseUrl = args.baseUrl;
  if (args.config !== undefined) instance.config = args.config;
  if (args.secretId !== undefined) instance.secretId = args.secretId;

  await instance.save();
  const refreshed = await db.AiProvider.findOne({
    where: { id: instance.id },
    include: getAiProviderIncludes(),
  });
  return mapAiProvider(refreshed!);
};

export const deleteAiProvider = async (args: {
  id: string;
  force?: boolean;
}) => {
  const instance = await db.AiProvider.findOne({
    where: { publicId: args.id },
  });
  if (!instance) return null;

  // TODO: add cascade check against chats when that module is implemented
  await instance.destroy();
  return 'deleted' as const;
};

export const resolveAiProviderSecret = async (args: {
  aiProviderId: string;
}) => {
  const instance = await db.AiProvider.findOne({
    where: { publicId: args.aiProviderId },
  });
  if (!instance) return null;

  let decryptedValue: string | null = null;
  if (instance.secretId) {
    const secret = await db.Secret.findByPk(instance.secretId);
    if (secret?.encryptedValue) {
      decryptedValue = decryptValue(secret.encryptedValue);
    }
  }

  return {
    provider: instance.provider,
    defaultModel: instance.defaultModel,
    baseUrl: instance.baseUrl ?? undefined,
    config: instance.config ?? undefined,
    secretValue: decryptedValue,
  };
};

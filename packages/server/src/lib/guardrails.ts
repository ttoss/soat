import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { validateGuardrailDocument } from './guardrailDocument';

const log = createDebug('soat:guardrails');

const CONTEXT_MODES = ['merge', 'replace'];

type GuardrailInstance = InstanceType<(typeof db)['Guardrail']>;
type GuardrailVersionInstance = InstanceType<(typeof db)['GuardrailVersion']>;

const getGuardrailIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

export const mapGuardrail = (guardrail: GuardrailInstance) => {
  return {
    id: guardrail.publicId,
    projectId: guardrail.project.publicId,
    name: guardrail.name,
    description: guardrail.description,
    version: guardrail.version,
    document: guardrail.document,
    contextToolId: guardrail.contextToolId,
    contextMode: guardrail.contextMode,
    createdAt: guardrail.createdAt,
    updatedAt: guardrail.updatedAt,
  };
};

export const mapGuardrailVersion = (
  version: GuardrailVersionInstance,
  guardrailPublicId: string
) => {
  return {
    guardrailId: guardrailPublicId,
    version: version.version,
    document: version.document,
    createdAt: version.createdAt,
  };
};

const validateContextMode = (contextMode: unknown): void => {
  if (
    contextMode !== undefined &&
    contextMode !== null &&
    !CONTEXT_MODES.includes(contextMode as string)
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Guardrail context_mode must be one of ${CONTEXT_MODES.join(' / ')}.`
    );
  }
};

const reloadWithIncludes = async (id: number) => {
  const reloaded = await db.Guardrail.findOne({
    where: { id },
    include: getGuardrailIncludes(),
  });
  return reloaded as GuardrailInstance;
};

export const createGuardrail = async (args: {
  projectId: number;
  name: string;
  description?: string;
  document: object;
  contextToolId?: string | null;
  contextMode?: string | null;
}): Promise<ReturnType<typeof mapGuardrail>> => {
  log(
    'createGuardrail: projectId=%d name=%s contextToolId=%s',
    args.projectId,
    args.name,
    args.contextToolId ?? null
  );

  validateGuardrailDocument(args.document);
  validateContextMode(args.contextMode);

  const guardrail = await db.Guardrail.create({
    projectId: args.projectId,
    name: args.name,
    description: args.description ?? null,
    version: 1,
    document: args.document,
    contextToolId: args.contextToolId ?? null,
    contextMode: args.contextMode ?? 'merge',
  });

  await db.GuardrailVersion.create({
    guardrailId: (guardrail as unknown as { id: number }).id,
    version: 1,
    document: args.document,
  });

  log('createGuardrail: created id=%s', guardrail.publicId);

  const created = await reloadWithIncludes(
    (guardrail as unknown as { id: number }).id
  );
  return mapGuardrail(created);
};

export const listGuardrails = async (args: {
  projectIds?: number[];
}): Promise<ReturnType<typeof mapGuardrail>[]> => {
  log('listGuardrails: projectIds=%o', args.projectIds);

  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const guardrails = await db.Guardrail.findAll({
    where,
    include: getGuardrailIncludes(),
    order: [['createdAt', 'DESC']],
  });

  return guardrails.map((guardrail) => {
    return mapGuardrail(guardrail as GuardrailInstance);
  });
};

const findGuardrailInstance = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<GuardrailInstance> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const guardrail = await db.Guardrail.findOne({
    where,
    include: getGuardrailIncludes(),
  });

  if (!guardrail) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Guardrail '${args.id}' not found.`
    );
  }

  return guardrail as GuardrailInstance;
};

export const getGuardrail = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<ReturnType<typeof mapGuardrail>> => {
  log('getGuardrail: id=%s', args.id);
  const guardrail = await findGuardrailInstance(args);
  return mapGuardrail(guardrail);
};

export const updateGuardrail = async (args: {
  projectIds?: number[];
  id: string;
  name?: string;
  description?: string | null;
  document?: object;
  contextToolId?: string | null;
  contextMode?: string | null;
}): Promise<ReturnType<typeof mapGuardrail>> => {
  log(
    'updateGuardrail: id=%s documentWrite=%s',
    args.id,
    args.document !== undefined
  );

  const guardrail = await findGuardrailInstance({
    projectIds: args.projectIds,
    id: args.id,
  });

  const updates: Record<string, unknown> = {};
  if (args.name !== undefined) updates.name = args.name;
  if (args.description !== undefined) updates.description = args.description;
  if (args.contextToolId !== undefined) {
    updates.contextToolId = args.contextToolId;
  }
  if (args.contextMode !== undefined) {
    validateContextMode(args.contextMode);
    updates.contextMode = args.contextMode;
  }

  // A `document` write bumps the version and archives the prior document as a
  // GuardrailVersion, so the audit chain survives edits. Metadata-only edits
  // (name / description / context) leave the version untouched.
  if (args.document !== undefined) {
    validateGuardrailDocument(args.document);
    const nextVersion = guardrail.version + 1;
    updates.document = args.document;
    updates.version = nextVersion;

    await guardrail.update(updates);

    await db.GuardrailVersion.create({
      guardrailId: (guardrail as unknown as { id: number }).id,
      version: nextVersion,
      document: args.document,
    });

    log('updateGuardrail: id=%s bumped to version=%d', args.id, nextVersion);
  } else {
    await guardrail.update(updates);
  }

  return mapGuardrail(guardrail);
};

export const deleteGuardrail = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<void> => {
  log('deleteGuardrail: id=%s', args.id);

  const guardrail = await findGuardrailInstance({
    projectIds: args.projectIds,
    id: args.id,
  });

  // Archived versions are owned by the guardrail; remove them before the parent
  // so no orphan version rows are left behind.
  await db.GuardrailVersion.destroy({
    where: { guardrailId: (guardrail as unknown as { id: number }).id },
  });

  await guardrail.destroy();
};

export const getGuardrailVersion = async (args: {
  projectIds?: number[];
  guardrailId: string;
  version: number;
}): Promise<ReturnType<typeof mapGuardrailVersion>> => {
  log('getGuardrailVersion: id=%s version=%d', args.guardrailId, args.version);

  const guardrail = await findGuardrailInstance({
    projectIds: args.projectIds,
    id: args.guardrailId,
  });

  const version = await db.GuardrailVersion.findOne({
    where: {
      guardrailId: (guardrail as unknown as { id: number }).id,
      version: args.version,
    },
  });

  if (!version) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Guardrail '${args.guardrailId}' has no version ${args.version}.`
    );
  }

  return mapGuardrailVersion(
    version as GuardrailVersionInstance,
    guardrail.publicId
  );
};

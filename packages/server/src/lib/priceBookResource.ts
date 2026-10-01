import { db } from '../db';
import { DomainError } from '../errors';
import { isLogic } from './jsonLogicMapping';
import { DEFAULT_METER_TYPE } from './priceCompute';
import { agentReferences, toolReferences } from './resourceReferences';

/** The meter each priceable resource type's rows price. */
export const RESOURCE_METER_TYPES = {
  tool: 'tool_execution',
  agent: 'llm_tokens',
} as const;

type PriceableType = keyof typeof RESOURCE_METER_TYPES;

/** The SKU vendor a resource row is filed under; `model` carries the SRN. */
export const RESOURCE_PROVIDER = 'soat';

// No execution of their own to meter: a pipeline is metered per step, and a
// client tool runs in the caller.
const UNPRICEABLE_TOOL_TYPES = new Set(['pipeline', 'client']);

export type PriceRowKey = {
  meterType: string;
  provider: string;
  model: string;
  resource: string | null;
  quantity: unknown;
};

const invalid = (message: string): DomainError => {
  return new DomainError('VALIDATION_FAILED', message);
};

const isPriceableType = (type: string): type is PriceableType => {
  return Object.hasOwn(RESOURCE_METER_TYPES, type);
};

const parseResourceSrn = (
  resource: string
): { projectPublicId: string; type: PriceableType; id: string } => {
  const parts = resource.split(':');
  if (parts.length !== 4 || parts[0] !== 'srn' || !isPriceableType(parts[2])) {
    throw invalid(
      `resource '${resource}' must be one tool's or agent's SRN, srn:<project_id>:<tool|agent>:<id>.`
    );
  }
  return { projectPublicId: parts[1], type: parts[2], id: parts[3] };
};

const assertPriceableTool = async (args: {
  projectId: number | null;
  id: string;
}): Promise<void> => {
  const tool = args.projectId
    ? await toolReferences.find({
        id: args.id,
        projectId: args.projectId,
        reach: 'project',
      })
    : null;
  if (!tool) {
    throw new DomainError('TOOL_NOT_FOUND', `Tool '${args.id}' not found.`);
  }
  if (UNPRICEABLE_TOOL_TYPES.has(tool.type)) {
    throw invalid(
      `A ${tool.type} tool has no execution of its own to price; price the tools it runs.`
    );
  }
};

const assertPriceableAgent = async (args: {
  projectId: number | null;
  id: string;
}): Promise<void> => {
  const agent = args.projectId
    ? await agentReferences.find({
        id: args.id,
        projectId: args.projectId,
        reach: 'project',
      })
    : null;
  if (!agent) {
    throw new DomainError('AGENT_NOT_FOUND', `Agent '${args.id}' not found.`);
  }
};

/** The resource's type, once it is known to exist and to be priceable. */
const assertPriceable = async (args: {
  resource: string;
  ownerProjectPublicId: string | null;
}): Promise<PriceableType> => {
  const { projectPublicId, type, id } = parseResourceSrn(args.resource);
  if (
    args.ownerProjectPublicId &&
    projectPublicId !== args.ownerProjectPublicId
  ) {
    throw new DomainError(
      'FORBIDDEN',
      `A project prices only its own resources; '${args.resource}' belongs to another project.`
    );
  }
  const project = await db.Project.findOne({
    where: { publicId: projectPublicId },
    attributes: ['id'],
  });
  const projectId = (project?.id as number | undefined) ?? null;
  await (type === 'tool' ? assertPriceableTool : assertPriceableAgent)({
    projectId,
    id,
  });
  return type;
};

const resourceKey = async (args: {
  resource: string;
  meterType?: string;
  provider?: string;
  model?: string;
  quantity?: unknown;
  ownerProjectPublicId: string | null;
}): Promise<PriceRowKey> => {
  if (args.provider !== undefined || args.model !== undefined) {
    throw invalid(
      'A resource row names its resource, not a provider or model.'
    );
  }
  if (args.quantity !== undefined && !isLogic(args.quantity)) {
    throw invalid('quantity must be a JSON Logic expression.');
  }
  const type = await assertPriceable(args);
  const meterType = RESOURCE_METER_TYPES[type];
  if ((args.meterType ?? meterType) !== meterType) {
    throw invalid(`A ${type}'s resource row prices '${meterType}'.`);
  }
  return {
    meterType,
    provider: RESOURCE_PROVIDER,
    model: args.resource,
    resource: args.resource,
    quantity: args.quantity ?? null,
  };
};

/**
 * The SKU key one price row writes under. A row naming a `resource` prices one
 * tool or agent, of `ownerProjectPublicId` when set; any other row prices a SKU, whose
 * meter type is one of `skuMeterTypes` when given.
 */
export const resolvePriceRowKey = async (args: {
  resource?: string;
  quantity?: unknown;
  meterType?: string;
  provider?: string;
  model?: string;
  ownerProjectPublicId: string | null;
  skuMeterTypes: readonly string[] | null;
}): Promise<PriceRowKey> => {
  if (args.resource !== undefined) {
    return resourceKey({ ...args, resource: args.resource });
  }
  const meterType = args.meterType ?? DEFAULT_METER_TYPE;
  if (args.quantity !== undefined) {
    throw invalid('quantity prices a resource row; name its resource.');
  }
  if (args.skuMeterTypes && !args.skuMeterTypes.includes(meterType)) {
    throw invalid(
      `A '${meterType}' row prices one resource; name it in resource.`
    );
  }
  if (!args.provider || !args.model) {
    throw invalid('A price row names its provider and model, or a resource.');
  }
  return {
    meterType,
    provider: args.provider,
    model: args.model,
    resource: null,
    quantity: null,
  };
};

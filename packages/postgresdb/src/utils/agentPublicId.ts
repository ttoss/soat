import type { Model } from '@ttoss/postgresdb';

type AgentAttributed = Model & {
  agentId: number | null;
  agentPublicId: string;
};

type FindOptions = NonNullable<
  Parameters<Model['sequelize']['models'][string]['findByPk']>[1]
>;

/**
 * Copies the agent's public id onto a record naming it, before validation, so
 * every writer fills the durable id the record keeps once the agent is gone.
 *
 * `options` is the validation options, which carry the write's transaction.
 */
export const fillAgentPublicId = async (
  instance: AgentAttributed,
  options: object
): Promise<void> => {
  if (instance.agentPublicId || !instance.agentId) return;
  const transaction =
    'transaction' in options
      ? (options.transaction as FindOptions['transaction'])
      : undefined;
  const agent = await instance.sequelize.models.Agent.findByPk(
    instance.agentId,
    { attributes: ['publicId'], transaction }
  );
  const publicId = agent?.get('publicId');
  if (typeof publicId === 'string') instance.agentPublicId = publicId;
};

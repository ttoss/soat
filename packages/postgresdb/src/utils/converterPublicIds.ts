import type { Model } from '@ttoss/postgresdb';

type ConverterAttributed = Model & {
  toolId: number | null;
  toolPublicId: string | null;
  agentId: number | null;
  agentPublicId: string | null;
};

type FindOptions = NonNullable<
  Parameters<Model['sequelize']['models'][string]['findByPk']>[1]
>;

const publicIdOf = async (args: {
  instance: ConverterAttributed;
  model: 'Tool' | 'Agent';
  id: number;
  options: object;
}): Promise<string | null> => {
  const transaction =
    'transaction' in args.options
      ? (args.options.transaction as FindOptions['transaction'])
      : undefined;
  const row = await args.instance.sequelize.models[args.model].findByPk(
    args.id,
    { attributes: ['publicId'], transaction }
  );
  const publicId = row?.get('publicId');
  return typeof publicId === 'string' ? publicId : null;
};

/**
 * Derives a rule's durable converter ids from its live foreign keys. A live
 * key wins; with neither live, the ids of a deleted converter stay as they are.
 *
 * `options` is the save options, which carry the write's transaction.
 */
export const fillConverterPublicIds = async (
  instance: ConverterAttributed,
  options: object
): Promise<void> => {
  if (instance.toolId) {
    if (instance.changed('toolId') || !instance.toolPublicId) {
      instance.toolPublicId = await publicIdOf({
        instance,
        model: 'Tool',
        id: instance.toolId,
        options,
      });
    }
    instance.agentPublicId = null;
  }
  if (instance.agentId) {
    if (instance.changed('agentId') || !instance.agentPublicId) {
      instance.agentPublicId = await publicIdOf({
        instance,
        model: 'Agent',
        id: instance.agentId,
        options,
      });
    }
    instance.toolPublicId = null;
  }
};

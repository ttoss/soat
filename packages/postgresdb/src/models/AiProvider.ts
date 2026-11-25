import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Project } from './Project';
import { Secret } from './Secret';

export const AI_PROVIDER_SLUGS = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'groq',
  'ollama',
  'azure',
  'bedrock',
  'vertex',
  'gateway',
  'custom',
] as const;

export type AiProviderSlug = (typeof AI_PROVIDER_SLUGS)[number];

@Table({
  tableName: 'ai_providers',
  indexes: [
    {
      name: 'ai_providers_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: AiProvider) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.aiProvider);
      }
    },
  },
})
export class AiProvider extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare projectId: number;

  @BelongsTo(() => {
    return Project;
  })
  declare project: Project;

  @ForeignKey(() => {
    return Secret;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare secretId: number | null;

  @BelongsTo(() => {
    return Secret;
  })
  declare secret: Secret | null;

  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @Column({
    type: DataType.ENUM(...AI_PROVIDER_SLUGS),
    allowNull: false,
  })
  declare provider: AiProviderSlug;

  @Column({ type: DataType.STRING, allowNull: false })
  declare defaultModel: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare baseUrl: string | null;

  @Column({ type: DataType.JSON, allowNull: true })
  declare config: Record<string, unknown> | null;

  /**
   * Alias → the model id sent to the vendor, or `{ ai_provider_id, model }`:
   * another provider of the project serves the alias under that vendor id.
   */
  @Column({ type: DataType.JSON, allowNull: true })
  declare modelAliases: Record<
    string,
    string | { ai_provider_id: string; model: string }
  > | null;

  /** Model name → the input modalities it accepts; a name absent declares none. */
  @Column({ type: DataType.JSON, allowNull: true })
  declare modelInputModalities: Record<string, string[]> | null;

  /** Model name → the input limits it declares; a name absent declares none. */
  @Column({ type: DataType.JSON, allowNull: true })
  declare modelInputLimits: Record<string, Record<string, unknown>> | null;

  /** Refuse a model that is not one of `modelAliases`. */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare modelAliasesOnly: boolean;

  /** Refuse a generation on this provider whose model no price row covers. */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare requirePricedModel: boolean;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}

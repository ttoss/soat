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
  'gateway',
  'custom',
] as const;

export type AiProviderSlug = (typeof AI_PROVIDER_SLUGS)[number];

@Table({
  tableName: 'ai_providers',
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
    unique: true,
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

  @Column({ type: DataType.JSONB, allowNull: true })
  declare config: Record<string, unknown> | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}

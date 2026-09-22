import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  HasMany,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Actor } from './Actor';
import { ConversationMessage } from './ConversationMessage';
import { Project } from './Project';

@Table({
  tableName: 'conversations',
  indexes: [
    {
      name: 'conversations_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      // Containment (`@>`) is the only way a tag bag is matched, by the
      // `?tags=` filter, knowledge search and a `soat:ResourceTag/<key>`
      // condition alike. `jsonb_path_ops` indexes whole key/value paths,
      // which is exactly what that match asks about.
      name: 'conversations_tags_gin_idx',
      using: 'gin',
      fields: [{ name: 'tags', operator: 'jsonb_path_ops' }],
    },
  ],
  hooks: {
    beforeValidate: (instance: Conversation) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.conversation);
      }
    },
  },
})
export class Conversation extends Model {
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

  @Column({ type: DataType.STRING, allowNull: true })
  declare name: string | null;

  @Column({
    type: DataType.STRING,
    allowNull: false,
    defaultValue: 'open',
  })
  declare status: string;

  /**
   * Whether this conversation's turns are embedded for vector retrieval.
   * `null` inherits `Project.defaultConversationRetrieval`. Turns are chunked
   * either way — `none` only leaves the vector off, so a turn stays readable
   * and lexically searchable without being paid for as an embedding.
   */
  @Column({ type: DataType.STRING(8), allowNull: true })
  declare retrieval: 'embed' | 'none' | null;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    defaultValue: {},
  })
  declare tags: Record<string, string> | null;

  @ForeignKey(() => {
    return Actor;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare actorId: number | null;

  @BelongsTo(() => {
    return Actor;
  })
  declare actor: Actor | null;

  @HasMany(() => {
    return ConversationMessage;
  })
  declare messages: ConversationMessage[];

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}

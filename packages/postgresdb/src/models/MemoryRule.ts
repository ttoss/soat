import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Agent } from './Agent';
import { AiProvider } from './AiProvider';
import { MemoryStore } from './MemoryStore';
import { Tool } from './Tool';

/**
 * The events a rule may bind to, and the only ones.
 *
 * `conversations.message.created` is deliberately absent: it fires per message,
 * including the user's and before the reply, so a rule bound there would read
 * half a turn. `agents.generation.completed` fires once per completed turn
 * whatever the transport — conversation or bare, streaming or not — which is
 * why it is the only event the built-in extractor may bind to.
 */
export const MEMORY_RULE_EVENTS = [
  'agents.generation.completed',
  'conversations.message.generated',
] as const;
export type MemoryRuleEvent = (typeof MEMORY_RULE_EVENTS)[number];

/**
 * An ingestion policy for a memory store: what a completed turn is allowed to
 * contribute to *this* corpus, and who decides.
 *
 * It lives on the destination, not on the agent, because the question it
 * answers is "what feeds this store?" — a property of the store. Configured on
 * the agent (as `knowledge_config.extraction` was) that answer is scattered
 * across every agent in the project, one store cannot have two extractors, and
 * the store has no say in who writes to it.
 *
 * The `write_memory` tool is not this. That is a capability grant on the agent,
 * governed by IAM; this is what the corpus accepts.
 *
 * `agentId` and `toolId` are the pluggable handler and are mutually exclusive.
 * **Both null runs the built-in extractor** — today's behaviour, relocated —
 * with `prompt` / `aiProviderId` / `model` as its overrides.
 */
@Table({
  tableName: 'memory_rules',
  hooks: {
    beforeValidate: (instance: MemoryRule) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.memoryRule);
      }
      if (instance.toolId && instance.agentId) {
        throw new Error(
          'MemoryRule cannot reference both a tool and an agent at the same time'
        );
      }
    },
  },
  indexes: [
    {
      name: 'memory_rules_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'memory_rules_memory_store_id_idx',
      fields: ['memory_store_id'],
    },
  ],
})
export class MemoryRule extends Model {
  @Column({ type: DataType.STRING(32), allowNull: false })
  declare publicId: string;

  /**
   * The destination, and the rule's owning scope. `CASCADE`: a rule is the
   * store's content policy and means nothing without it.
   */
  @ForeignKey(() => {
    return MemoryStore;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare memoryStoreId: number;

  @BelongsTo(
    () => {
      return MemoryStore;
    },
    { onDelete: 'CASCADE' }
  )
  declare memoryStore: MemoryStore;

  @Column({ type: DataType.STRING(64), allowNull: false })
  declare on: MemoryRuleEvent;

  /**
   * The selector: agent public ids whose turns this rule reads. `null` is every
   * agent in the store's project.
   *
   * Public ids rather than a join table, because the selector is matched
   * against an event that already carries them, and because a rule naming an
   * agent must not keep that agent from being deleted.
   */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare sourceAgentIds: string[] | null;

  /** Handler; mutually exclusive with `toolId`. Both null is the built-in extractor. */
  @ForeignKey(() => {
    return Agent;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare agentId: number | null;

  @BelongsTo(
    () => {
      return Agent;
    },
    { onDelete: 'RESTRICT' }
  )
  declare agent: Agent | null;

  @ForeignKey(() => {
    return Tool;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare toolId: number | null;

  @BelongsTo(
    () => {
      return Tool;
    },
    { onDelete: 'RESTRICT' }
  )
  declare tool: Tool | null;

  /** The tool handler's operation id. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare action: string | null;

  /** Merged into a tool handler's input before invocation. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare presetParameters: Record<string, unknown> | null;

  /** Built-in extractor overrides — the retired `ExtractionConfig` fields. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare prompt: string | null;

  @ForeignKey(() => {
    return AiProvider;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare aiProviderId: number | null;

  @BelongsTo(
    () => {
      return AiProvider;
    },
    { onDelete: 'SET NULL' }
  )
  declare aiProvider: AiProvider | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare model: string | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare enabled: boolean;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}

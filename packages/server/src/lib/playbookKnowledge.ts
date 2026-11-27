import { isDeepStrictEqual } from 'node:util';

import createDebug from 'debug';

import { DomainError } from '../errors';
import {
  mergeKnowledgeConfig,
  readKnowledgeConfig,
  writeKnowledgeConfig,
} from './agentKnowledgeConfig';
import { isPlainObject } from './plainObject';
import type { JsonValue, PlaybookKnowledge } from './playbookDefinition';

const log = createDebug('soat:playbookKnowledge');

/** A capability grant an agent holds; a generation's per-call config never names it. */
const AGENT_ONLY_FIELD = 'write_memory_store_id';

const invalid = (message: string): DomainError => {
  return new DomainError('VALIDATION_FAILED', message);
};

/**
 * A `knowledge` bag is a generation's per-call `knowledge_config`: one the
 * knowledge reader reads back whole, so no field is dropped or mistyped.
 */
export const readPlaybookKnowledge = (args: {
  path: string;
  value: unknown;
}): PlaybookKnowledge | undefined => {
  const { path, value } = args;
  if (value === undefined) return undefined;
  const read =
    isPlainObject(value) && !Object.hasOwn(value, AGENT_ONLY_FIELD)
      ? readKnowledgeConfig(value)
      : undefined;
  if (!read || !isDeepStrictEqual(writeKnowledgeConfig(read), value)) {
    throw invalid(
      `${path} must be a knowledge_config a generation takes: document_paths, document_ids, memory_store_ids, tags, limit, min_score, rrf_k, recency_half_life_days.`
    );
  }
  // Read off a JSON body, so already a JSON value.
  return value as Record<string, JsonValue>;
};

/** Only an `agent` executor runs a generation for the knowledge to reach. */
export const readExecutorKnowledge = (args: {
  path: string;
  executor: Record<string, unknown>;
}): PlaybookKnowledge | undefined => {
  const { path, executor } = args;
  if (executor.knowledge === undefined) return undefined;
  if (executor.type !== 'agent') {
    throw invalid(`${path}.knowledge is only read on an agent executor.`);
  }
  return readPlaybookKnowledge({
    path: `${path}.knowledge`,
    value: executor.knowledge,
  });
};

/**
 * The per-call `knowledge_config` of a node's generation: the executor's over
 * the playbook's, merged as a per-call config merges over an agent's.
 */
export const nodeKnowledgeConfig = (args: {
  playbook?: PlaybookKnowledge;
  executor?: PlaybookKnowledge;
}): Record<string, unknown> | undefined => {
  const merged = mergeKnowledgeConfig({
    base: readKnowledgeConfig(args.playbook),
    override: readKnowledgeConfig(args.executor) ?? undefined,
  });
  log('nodeKnowledgeConfig: declared=%s', merged ? 'yes' : 'no');
  return merged ? writeKnowledgeConfig(merged) : undefined;
};

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const modelsDir = path.join(repoRoot, 'packages/postgresdb/src/models');
const serverSrcDir = path.join(repoRoot, 'packages/server/src');

/**
 * Every `JSON`/`JSONB` model column by role (`packages/postgresdb/README.md`,
 * "JSON or JSONB"): `order` is a caller-written document whose key order
 * carries meaning, stored `JSON`; `query` is one the server filters on or
 * indexes, stored `JSONB`. Keyed `<Model>.<attribute>`.
 */
const ROLES = {
  order: [
    'Decider.questions',
    'DeciderVersion.config',
    'Decision.questions',
    'Playbook.definition',
    'PlaybookEntry.value',
    'PlaybookExecution.input',
    'PlaybookExecution.output',
    'PlaybookVersion.config',
  ],
  query: [
    'Actor.tags',
    'Conversation.tags',
    'Document.metadata',
    'Document.tags',
    'File.tags',
    'Memory.tags',
    'MemoryStore.tags',
    'Session.tags',
    'Task.metadata',
    'UsageEvent.guardrailIds',
  ],
};

/**
 * `JSONB` columns not yet held to the rule, by the change that settles them.
 * `schemas` and `definitions` move to `JSON` (`order`); each of `remaining` is
 * classified `order` or `query` and stored as its role says. Empty when done.
 */
const PENDING = {
  /** JSON Schemas sent to a provider. */
  schemas: ['Agent.outputSchema', 'Tool.parameters'],
  /** Resource definitions and the versions a restore replays. */
  definitions: [
    'Agent.activeToolIds',
    'Agent.boundaryPolicy',
    'Agent.guardrailIds',
    'Agent.knowledgeConfig',
    'Agent.promptCaching',
    'Agent.reasoning',
    'Agent.stepRules',
    'Agent.stopConditions',
    'Agent.toolBindings',
    'Agent.toolChoice',
    'AgentVersion.config',
    'Guardrail.document',
    'GuardrailVersion.config',
    'Orchestration.edges',
    'Orchestration.inputSchema',
    'Orchestration.nodes',
    'Orchestration.outputMapping',
    'Orchestration.stateSchema',
    'OrchestrationVersion.config',
    'Workflow.payloadSchema',
    'Workflow.states',
    'Workflow.transitions',
    'WorkflowVersion.config',
  ],
  remaining: [
    'ActivityEntry.detail',
    'Agent.activeRelease',
    'AiProvider.config',
    'ApprovalItem.editedArguments',
    'ApprovalItem.evidence',
    'ApprovalItem.proposedAction',
    'ApprovalItem.taskPayload',
    'AuditEntry.detail',
    'AuditEntry.onBehalfOf',
    'ConversationMessage.metadata',
    'ConversationMessage.responseMessages',
    'DatasetItem.input',
    'DatasetItem.metadata',
    'Decision.answers',
    'Decision.error',
    'Decision.metadata',
    'Document.error',
    'DocumentVersion.config',
    'Eval.scorers',
    'EvalResult.error',
    'EvalResult.input',
    'EvalResult.scores',
    'EvalRun.aggregateScores',
    'EvalRun.deciderVersions',
    'EvalRun.metadata',
    'EvalRun.toolContext',
    'ExceptionItem.detail',
    'File.metadata',
    'Formation.error',
    'Formation.metadata',
    'Formation.outputs',
    'Formation.resolvedMetadata',
    'Formation.resolvedParameters',
    'Formation.template',
    'FormationOperation.error',
    'FormationOperation.events',
    'FormationOperation.plan',
    'FormationResource.lastAppliedProperties',
    'FormationResource.pendingCleanupPhysicalResourceIds',
    'Generation.error',
    'Generation.extraction',
    'Generation.inputMessages',
    'Generation.inputModalities',
    'Generation.metadata',
    'Generation.pendingState',
    'Generation.retrieval',
    'Generation.routing',
    'Generation.toolSurface',
    'GuardrailEvaluation.contextSnapshot',
    'IngestionRule.metadata',
    'IngestionRule.presetParameters',
    'Memory.metadata',
    'MemoryRule.presetParameters',
    'MemoryRule.sourceAgentIds',
    'MetadataSchema.schema',
    'ModelRoute.retryOn',
    'ModelRoute.targets',
    'OauthAuthCode.codeData',
    'OauthClient.clientData',
    'OrchestrationCheckpoint.artifacts',
    'OrchestrationCheckpoint.state',
    'OrchestrationNodeExecution.error',
    'OrchestrationNodeExecution.input',
    'OrchestrationNodeExecution.output',
    'OrchestrationRun.activeNodes',
    'OrchestrationRun.artifacts',
    'OrchestrationRun.error',
    'OrchestrationRun.input',
    'OrchestrationRun.metadata',
    'OrchestrationRun.output',
    'OrchestrationRun.requiredAction',
    'OrchestrationRun.state',
    'OrchestrationRun.toolContext',
    'OrchestrationRun.wakeContext',
    'PlaybookEntry.basis',
    'PlaybookEntry.onBehalfOf',
    'PlaybookExecution.basis',
    'PlaybookExecution.error',
    'PlaybookExecution.onBehalfOf',
    'PlaybookExport.error',
    'PlaybookExport.onBehalfOf',
    'PlaybookUpgrade.diff',
    'PlaybookUpgrade.onBehalfOf',
    'Policy.document',
    'PriceBook.quantity',
    'Project.guardrailIds',
    'Session.toolContext',
    'Share.actions',
    'Share.cap',
    'Task.activeDispatch',
    'Task.lastResult',
    'Task.payload',
    'Task.toolContext',
    'Tool.actions',
    'Tool.contextKeys',
    'Tool.deniedActions',
    'Tool.execute',
    'Tool.guardrailIds',
    'Tool.mcp',
    'Tool.outputMapping',
    'Tool.pipeline',
    'Tool.presetParameters',
    'Trace.error',
    'Trace.stepSegments',
    'Trigger.input',
    'Trigger.toolContext',
    'TriggerFiring.causationChain',
    'TriggerFiring.error',
    'TriggerFiring.input',
    'TriggerFiring.result',
    'WebhookDelivery.payload',
    'WorkflowMigration.items',
    'WorkflowMigration.stateMap',
  ],
};

/** The storage each class must have. */
const EXPECTED_TYPE = { order: 'JSON', query: 'JSONB', pending: 'JSONB' };

/** `<Model>.<attribute>` → `JSON` | `JSONB`, read from each `@Column`'s type. */
const modelColumns = () => {
  const columns = new Map();
  for (const entry of fs.readdirSync(modelsDir).sort()) {
    if (!entry.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(modelsDir, entry), 'utf-8');
    const type = /DataType\.(JSONB|JSON)\b/g;
    let match;
    while ((match = type.exec(source))) {
      const declare = /declare\s+(\w+)/g;
      declare.lastIndex = match.index;
      const attribute = declare.exec(source)[1];
      columns.set(`${entry.replace(/\.ts$/, '')}.${attribute}`, match[1]);
    }
  }
  return columns;
};

const classified = [
  ...ROLES.order.map((column) => {
    return [column, 'order'];
  }),
  ...ROLES.query.map((column) => {
    return [column, 'query'];
  }),
  ...Object.values(PENDING)
    .flat()
    .map((column) => {
      return [column, 'pending'];
    }),
];

describe('JSON column roles', () => {
  const columns = modelColumns();

  test('every JSON/JSONB column is classified once', () => {
    const names = classified.map(([column]) => {
      return column;
    });
    const duplicated = names.filter((column, index) => {
      return names.indexOf(column) !== index;
    });
    const unclassified = [...columns.keys()].filter((column) => {
      return !names.includes(column);
    });
    const stale = names.filter((column) => {
      return !columns.has(column);
    });

    assert.deepEqual(
      { duplicated, unclassified, stale },
      {
        duplicated: [],
        unclassified: [],
        stale: [],
      }
    );
  });

  test('every column is stored as its class says', () => {
    const contradicting = classified
      .filter(([column, role]) => {
        return (
          columns.has(column) && columns.get(column) !== EXPECTED_TYPE[role]
        );
      })
      .map(([column, role]) => {
        return `${column} is ${columns.get(column)}, ${role} is ${EXPECTED_TYPE[role]}`;
      });

    assert.deepEqual(contradicting, []);
  });
});

/**
 * A `jsonb_*` function fails on a `JSON` column, so a query reads a column
 * through the one helper, which casts it to `jsonb` whatever its storage.
 */
describe('jsonb functions on model columns', () => {
  const HELPER = 'lib/jsonbQuery.ts';

  /** Source with comments dropped, so prose naming a function is not a hit. */
  const code = (file) => {
    return fs
      .readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => {
        return !/^\s*(\/\/|\*)/.test(line);
      })
      .join('\n');
  };

  test('only the helper calls a jsonb_* function', () => {
    const callers = fs
      .readdirSync(serverSrcDir, { recursive: true })
      .filter((entry) => {
        return typeof entry === 'string' && entry.endsWith('.ts');
      })
      .map((entry) => {
        return entry.split(path.sep).join('/');
      })
      .filter((entry) => {
        return (
          entry !== HELPER &&
          /\bjsonb_\w+/.test(code(path.join(serverSrcDir, entry)))
        );
      })
      .sort();

    assert.deepEqual(callers, []);
  });
});

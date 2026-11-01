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
    'ActivityEntry.detail',
    'Agent.activeRelease',
    'Agent.activeToolIds',
    'Agent.boundaryPolicy',
    'Agent.guardrailIds',
    'Agent.knowledgeConfig',
    'Agent.outputSchema',
    'Agent.promptCaching',
    'Agent.reasoning',
    'Agent.stepRules',
    'Agent.stopConditions',
    'Agent.toolBindings',
    'Agent.toolChoice',
    'AgentVersion.config',
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
    'Decider.questions',
    'DeciderVersion.config',
    'Decision.answers',
    'Decision.error',
    'Decision.metadata',
    'Decision.questions',
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
    'Guardrail.document',
    'GuardrailEvaluation.contextSnapshot',
    'GuardrailVersion.config',
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
    'Orchestration.edges',
    'Orchestration.inputSchema',
    'Orchestration.nodes',
    'Orchestration.outputMapping',
    'Orchestration.stateSchema',
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
    'OrchestrationVersion.config',
    'Playbook.definition',
    'PlaybookEntry.basis',
    'PlaybookEntry.onBehalfOf',
    'PlaybookEntry.value',
    'PlaybookExecution.basis',
    'PlaybookExecution.error',
    'PlaybookExecution.input',
    'PlaybookExecution.onBehalfOf',
    'PlaybookExecution.output',
    'PlaybookExport.error',
    'PlaybookExport.onBehalfOf',
    'PlaybookUpgrade.diff',
    'PlaybookUpgrade.onBehalfOf',
    'PlaybookVersion.config',
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
    'Tool.parameters',
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
    'Workflow.payloadSchema',
    'Workflow.states',
    'Workflow.transitions',
    'WorkflowMigration.items',
    'WorkflowMigration.stateMap',
    'WorkflowVersion.config',
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

/** The storage each class must have. */
const EXPECTED_TYPE = { order: 'JSON', query: 'JSONB' };

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

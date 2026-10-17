import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';
import { RUN_STATUSES } from 'src/lib/runStatus';
import { SOAT_EVENT_TYPES } from 'src/lib/soatEvents';

/**
 * Drift guardrail — pure validation with no REST entry point.
 *
 * Every record that runs or settles answers in one vocabulary
 * (`RUN_STATUSES`), so a caller polling a generation, a run, a firing or a
 * delivery tests one terminal set. A module adds only the pauses below, never
 * a synonym: `succeeded` beside `completed` makes a client that waits for
 * `completed` hang on the module that says the other word.
 *
 * Every `status`-named enum in every spec — a schema property, a request
 * field, a listing filter — is held to that vocabulary, except the domain
 * lifecycles below, which describe a resource rather than a run. Event names
 * follow the status they announce (`orchestration_runs.completed`).
 */

const SPEC_DIR = path.resolve(__dirname, '../../../../src/rest/openapi/v1');

/** The non-terminal pauses (and one listing sentinel) a module may add. */
const MODULE_WORDS: Record<string, string> = {
  requires_action: 'parked on a client-side tool result',
  awaiting_input: 'parked on a human node',
  sleeping: 'parked on a timer until its wake is due',
  paused: 'held by an operator or a project pause',
  waiting: 'parked on a task or run it started',
  idle: 'a playbook case with no execution in flight',
  skipped: 'a node a branch did not take',
  expired: 'a run that outlived its deadline',
  unrouted: 'a task no automation route matched',
  none: 'the `automation_status` filter for a task with no dispatch',
};

/**
 * Words that spell a run state the vocabulary already names. `pending` is not
 * among them: an approval or a document is pending a verdict or an ingestion,
 * and outside those lifecycles the vocabulary test already refuses it.
 */
const SYNONYMS = new Set(['succeeded', 'success', 'canceled', 'in_progress']);

/**
 * Enums that describe a resource's own lifecycle or a verdict, not a run.
 * Keyed `<file>#<schema or operation>.<property>`.
 */
const DOMAIN_LIFECYCLES: Record<string, string> = {
  'approvals.yaml#ApprovalItem.status': 'a verdict on a request',
  'approvals.yaml#ApprovalRecurrenceGroup.status': 'a verdict on a request',
  'approvals.yaml#GET /api/v1/approvals.status': 'a verdict on a request',
  'approvals.yaml#GET /api/v1/approvals/recurrences.status':
    'a verdict on a request',
  'documents.yaml#DocumentRecord.status':
    'a document stays readable through ingestion and after it',
  'documents.yaml#DocumentStatusRecord.status':
    'a document stays readable through ingestion and after it',
  'chains.yaml#Chain.status': 'a conversation chain and its budget',
  'chains.yaml#GET /api/v1/chains.status':
    'a conversation chain and its budget',
  'conversations.yaml#ConversationRecord.status': 'a conversation is a thread',
  'conversations.yaml#POST /api/v1/conversations.status':
    'a conversation is a thread',
  'conversations.yaml#PATCH /api/v1/conversations/{conversation_id}.status':
    'a conversation is a thread',
  'conversations.yaml#POST /api/v1/conversations/{conversation_id}/generate.status':
    'the acknowledgement of a background generate, not a state it holds',
  'agents.yaml#AcceptedGenerationResponse.status':
    'the acknowledgement of a background generate, not a state it holds',
  'sessions.yaml#POST /api/v1/sessions/{session_id}/generate.status':
    'the acknowledgement of a background generate, not a state it holds',
  'sessions.yaml#SessionRecord.status': 'a session is a thread with a TTL',
  'sessions.yaml#UpdateSessionRequest.status':
    'a session is a thread with a TTL',
  'sessions.yaml#GET /api/v1/sessions.status':
    'a session is a thread with a TTL',
  'exceptions.yaml#ExceptionItem.status': 'a filed exception is triaged',
  'exceptions.yaml#GET /api/v1/exceptions.status':
    'a filed exception is triaged',
  'shares.yaml#ShareAcceptance.status': 'an acceptance is held or revoked',
  'shares.yaml#GET /api/v1/shares/{share_id}/acceptances.status':
    'an acceptance is held or revoked',
  'tasks.yaml#Task.status':
    'a task is a work item moving through its workflow states',
  'tasks.yaml#GET /api/v1/tasks.status':
    'a task is a work item moving through its workflow states',
  'formations.yaml#Formation.status': 'the deployed state of a stack',
  'formations.yaml#FormationResource.status':
    'what the last deploy left a resource as',
};

type StatusEnum = { location: string; values: string[] };

const isObjectRecord = (node: unknown): node is Record<string, unknown> => {
  return typeof node === 'object' && node !== null && !Array.isArray(node);
};

const isStatusName = (name: string): boolean => {
  return name === 'status' || name.endsWith('_status');
};

/** Follows a local `$ref` and `items`, which is where a status enum sits. */
const enumOf = (args: {
  node: unknown;
  schemas: Record<string, unknown>;
}): string[] | undefined => {
  const { node, schemas } = args;
  if (!isObjectRecord(node)) return undefined;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    const name = node.$ref.split('/').pop() ?? '';
    return enumOf({ node: schemas[name], schemas });
  }
  if (Array.isArray(node.enum)) {
    return node.enum.filter((value): value is string => {
      return typeof value === 'string';
    });
  }
  return enumOf({ node: node.items, schemas });
};

/** `ApprovalItem` for a component, `GET /api/v1/approvals` for an operation. */
const ownerOf = (trail: string[]): string => {
  if (trail[0] === 'components') return trail[2];
  return `${trail[2].toUpperCase()} ${trail[1]}`;
};

const collect = (args: {
  node: unknown;
  trail: string[];
  file: string;
  schemas: Record<string, unknown>;
  out: StatusEnum[];
}): void => {
  const { node, trail, file, schemas, out } = args;
  if (Array.isArray(node)) {
    for (const item of node) collect({ ...args, node: item });
    return;
  }
  if (!isObjectRecord(node)) return;

  const add = (name: string, schema: unknown) => {
    const values = enumOf({ node: schema, schemas });
    if (values) {
      out.push({ location: `${file}#${ownerOf(trail)}.${name}`, values });
    }
  };

  if (isObjectRecord(node.properties)) {
    for (const [name, schema] of Object.entries(node.properties)) {
      if (isStatusName(name)) add(name, schema);
    }
  }
  if (typeof node.name === 'string' && node.in && isStatusName(node.name)) {
    add(node.name, node.schema);
  }

  for (const [key, value] of Object.entries(node)) {
    collect({ ...args, node: value, trail: [...trail, key] });
  }
};

const loadStatusEnums = (): StatusEnum[] => {
  const out: StatusEnum[] = [];
  const files = fs.readdirSync(SPEC_DIR).filter((file) => {
    return file.endsWith('.yaml');
  });
  for (const file of files.sort()) {
    const spec = load(fs.readFileSync(path.join(SPEC_DIR, file), 'utf-8'));
    if (!isObjectRecord(spec)) continue;
    const components = isObjectRecord(spec.components) ? spec.components : {};
    const schemas = isObjectRecord(components.schemas)
      ? components.schemas
      : {};
    collect({ node: spec.paths, trail: ['paths'], file, schemas, out });
    for (const section of ['schemas', 'parameters']) {
      const entries = isObjectRecord(components[section])
        ? components[section]
        : {};
      for (const [name, node] of Object.entries(entries)) {
        collect({
          node,
          trail: ['components', section, name],
          file,
          schemas,
          out,
        });
      }
    }
  }
  return out;
};

const VOCABULARY = new Set<string>([
  ...RUN_STATUSES,
  ...Object.keys(MODULE_WORDS),
]);

describe('status vocabulary', () => {
  const statusEnums = loadStatusEnums();

  test('the walk finds the run statuses it guards', () => {
    const locations = statusEnums.map((entry) => {
      return entry.location;
    });
    expect(locations).toEqual(
      expect.arrayContaining([
        'generations.yaml#Generation.status',
        'orchestrations.yaml#OrchestrationRun.status',
        'orchestrations.yaml#GET /api/v1/orchestration-runs.status',
        'webhooks.yaml#Delivery.status',
        'triggers.yaml#TriggerFiring.status',
        'formations.yaml#FormationOperation.status',
        'playbooks.yaml#PlaybookExecution.status',
        'evaluations.yaml#EvalRun.status',
        'tasks.yaml#Task.automation_status',
        'playbooks.yaml#PlaybookCaseSummary.automation_status',
      ])
    );
  });

  test('a run status uses only the shared words and its module pauses', () => {
    const violations = statusEnums
      .filter((entry) => {
        return !(entry.location in DOMAIN_LIFECYCLES);
      })
      .flatMap((entry) => {
        return entry.values
          .filter((value) => {
            return !VOCABULARY.has(value);
          })
          .map((value) => {
            return `${entry.location}: ${value}`;
          });
      });
    expect(violations).toEqual([]);
  });

  test('a domain lifecycle never spells a run state another way', () => {
    const violations = statusEnums
      .filter((entry) => {
        return entry.location in DOMAIN_LIFECYCLES;
      })
      .flatMap((entry) => {
        return entry.values
          .filter((value) => {
            return SYNONYMS.has(value);
          })
          .map((value) => {
            return `${entry.location}: ${value}`;
          });
      });
    expect(violations).toEqual([]);
  });

  test('no platform event is named for a run state another way', () => {
    const misnamed = SOAT_EVENT_TYPES.filter((type) => {
      return SYNONYMS.has(type.split('.').at(-1) ?? '');
    });
    expect(misnamed).toEqual([]);
  });

  test('every domain lifecycle exemption names an enum that exists', () => {
    const locations = new Set(
      statusEnums.map((entry) => {
        return entry.location;
      })
    );
    const stale = Object.keys(DOMAIN_LIFECYCLES).filter((location) => {
      return !locations.has(location);
    });
    expect(stale).toEqual([]);
  });
});

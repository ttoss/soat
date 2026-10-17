import { eventBus, type SoatEvent } from 'src/lib/eventBus';
import { isSoatEventType, type SoatResourceType } from 'src/lib/soatEvents';

/**
 * Holds every event the suite emits to the payload contract `webhooks.md`
 * publishes: `data` is the record `GET` answers for `resource_type` /
 * `resource_id`, with any event-specific fact beside it, all snake_case.
 *
 * Observed on the bus rather than asserted per test, so an emitter no test
 * inspects is held to it too: any test that reaches an emit site checks it.
 *
 * Top-level keys only, the depth `responseContract` checks: below it sit the
 * record's opaque bags (`tags`, `metadata`, a task `payload`), whose keys are
 * whatever their writer chose.
 */

/**
 * The key naming the record, when it is not `id`: a conversation message is
 * addressed by its document.
 */
const IDENTITY_KEY: Partial<Record<SoatResourceType, string>> = {
  conversation_message: 'document_id',
};

/**
 * Events whose emitters (`agentGenerationHelpers.ts`,
 * `sessionGenerationHelpers.ts`, `usageThresholds.ts`) carry a payload of their
 * own rather than the record. An entry leaves this set when its emitter
 * carries the record; the check then holds it like every other event.
 */
const OUTSIDE_CONTRACT = new Set<string>([
  'agents.generation.requires_action',
  'agents.generation.completed',
  'sessions.generation.started',
  'sessions.generation.requires_action',
  'sessions.generation.completed',
  'usage.threshold_crossed',
]);

const isCamelCase = (key: string): boolean => {
  return /[a-z][A-Z]/.test(key);
};

/** What is wrong with one event's `data`; empty when it holds the contract. */
export const eventRecordFindings = (event: SoatEvent): string[] => {
  // A user-authored `emit_event` name carries whatever its template wrote.
  if (!isSoatEventType(event.type)) return [];
  if (OUTSIDE_CONTRACT.has(event.type)) return [];

  const where = `${event.type} (${event.resourceId})`;
  const { data } = event;

  const findings = Object.keys(data)
    .filter(isCamelCase)
    .map((key) => {
      return `${where}: camelCase key '${key}'`;
    });

  const identityKey = IDENTITY_KEY[event.resourceType] ?? 'id';
  if (data[identityKey] !== event.resourceId) {
    findings.push(
      `${where}: data.${identityKey} is ${JSON.stringify(data[identityKey])}, not the resource_id`
    );
  }

  return findings;
};

/**
 * Registers the check on the surrounding suite. A finding fails the test
 * running when it is reported; an emit that lands after the file's last test
 * fails its `afterAll`.
 */
export const installEventRecordContract = (): void => {
  const findings: string[] = [];
  const listener = (event: SoatEvent) => {
    findings.push(...eventRecordFindings(event));
  };

  const report = () => {
    const reported = findings.splice(0);
    if (reported.length > 0) {
      throw new Error(`Event payload contract broken:\n${reported.join('\n')}`);
    }
  };

  // Re-attached per test: a test that clears the bus's listeners would
  // otherwise switch the check off for the rest of its file.
  beforeEach(() => {
    if (!eventBus.listeners('soat:event').includes(listener)) {
      eventBus.on('soat:event', listener);
    }
  });

  afterEach(report);

  afterAll(() => {
    eventBus.off('soat:event', listener);
    report();
  });
};

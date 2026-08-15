/**
 * The registry of platform events, keyed by the resource type each belongs to.
 *
 * This is the single source of truth for three things that used to drift apart:
 * the union `emitResourceEvent` accepts, the set a subscriber may declare
 * interest in, and the event table in the webhooks documentation (generated
 * from here by `packages/website/scripts/generateWebhookEventsPage.ts`).
 *
 * Before this existed, `type` and `resourceType` were both bare `string`s. A
 * renamed or misspelled event name compiled fine and simply never matched, so a
 * webhook subscription stopped delivering with nothing failing anywhere. Pairing
 * the name with its resource type here is what turns that into a type error at
 * the emit site: `emitResourceEvent` draws the names it accepts from the entry
 * for the `resourceType` it was given.
 *
 * The description is part of the entry rather than a parallel table because the
 * generated reference reads it — a new event is documented by the same edit that
 * registers it, or it is not registered at all.
 *
 * **This file deliberately imports nothing.** It is loaded by the website's docs
 * generator as well as the server, so a runtime import here would drag the DB
 * layer into a docs build.
 *
 * ### What is *not* here
 *
 * The event `data` payload stays an opaque value and is not described by this
 * registry. Typing it per event would tie the bus to each module's mapper return
 * type, which is exactly the coupling `.claude/rules/case-convention.md` removed:
 * nothing on the bus reads a key of the payload, so nothing on the bus needs to
 * know its shape. Type the envelope; keep the payload a value.
 */
export const SOAT_EVENTS = {
  agent: {
    'agents.created': 'An agent was created.',
    'agents.updated': 'An agent was updated.',
    'agents.deleted': 'An agent was deleted.',
  },
  approval: {
    'approvals.created': 'An approval request was raised and is pending.',
    'approvals.approved': 'A pending approval was approved.',
    'approvals.rejected': 'A pending approval was rejected.',
    'approvals.expired': 'A pending approval passed its deadline unanswered.',
  },
  audit: {
    'audit.entry_created': 'An audit entry was recorded.',
  },
  conversation: {
    'conversations.created': 'A conversation was created.',
    'conversations.updated': 'A conversation was updated.',
    'conversations.deleted': 'A conversation was deleted.',
  },
  conversation_message: {
    'conversations.message.created': 'A message was added to a conversation.',
    'conversations.message.generated':
      'An assistant message was generated in a conversation.',
    'conversations.message.deleted':
      'A message was removed from a conversation.',
  },
  document: {
    'documents.created': 'A document was created.',
    'documents.updated': 'A document was updated.',
    'documents.deleted': 'A document was deleted.',
    'documents.ingested':
      'A document finished ingestion and is indexed (`status=ready`); the payload carries the document plus its final `chunk_count`.',
    'documents.ingest_failed':
      'A document ingestion settled in failure (`status=failed`); the payload carries the document plus the `error` reason (e.g. `FILE_PARSE_FAILED`, `INGESTION_TIMEOUT`).',
  },
  eval_run: {
    'eval_run.completed':
      'An eval run reached a terminal status with its items scored; carries the pass/fail verdict consumed by eval-gated promotion.',
    'eval_run.failed':
      'An eval run could not be executed to completion (infrastructure failure).',
  },
  exception: {
    'exceptions.created': 'An exception was filed.',
  },
  file: {
    'files.created': 'A file was uploaded.',
    'files.updated': 'A file was updated.',
    'files.deleted': 'A file was deleted.',
  },
  generation: {
    'agents.generation.requires_action':
      'An agent generation paused for a client-side tool result.',
    'agents.generation.completed': 'An agent generation completed.',
    'agents.generation.failed': 'An agent generation failed.',
    'generations.content_purged':
      "A generation's content was redacted, leaving its auditable skeleton.",
  },
  guardrail: {
    'guardrail.tripwire': 'A guardrail tripwire aborted a tool call.',
  },
  orchestration_run: {
    'orchestration_runs.started': 'An orchestration run started.',
    'orchestration_runs.awaiting_input':
      'An orchestration run paused waiting for input.',
    'orchestration_runs.succeeded': 'An orchestration run succeeded.',
    'orchestration_runs.failed': 'An orchestration run failed.',
  },
  quota: {
    'quota.exceeded': 'A quota limit was exceeded.',
  },
  session: {
    'sessions.created': 'A session was created.',
    'sessions.updated': 'A session was updated.',
    'sessions.deleted': 'A session was deleted.',
    'sessions.tags.updated': "A session's tags were replaced.",
    'sessions.generation.started': 'A session generation started.',
    'sessions.generation.requires_action':
      'A session generation paused for a client-side tool result.',
    'sessions.generation.completed': 'A session generation completed.',
  },
  task: {
    'tasks.created': 'A task was created.',
    'tasks.transitioned': 'A task moved to a new state.',
    'tasks.closed': 'A task reached a terminal state.',
    'tasks.stalled': 'A task exceeded its stall threshold without progress.',
    'tasks.approval_failed': "A task's approval gate was rejected or expired.",
    'tasks.automation_retrying': "A task's automation is being retried.",
    'tasks.automation_rejected': "A task's automation rejected the task.",
    'tasks.automation_unrouted': 'A task matched no automation route.',
  },
  trace: {
    'traces.content_purged':
      "A trace's content was redacted, leaving its auditable skeleton.",
  },
  usage_threshold: {
    'usage.threshold_crossed': 'A usage threshold was crossed.',
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, string>>>>;

/** The resource types the bus can carry an event for. */
export type SoatResourceType = keyof typeof SOAT_EVENTS;

/**
 * Resource type -> the event names registered for it. Both public aliases index
 * this one map so the compiler relates them: `EventTypesByResource[R]` is
 * assignable to `EventTypesByResource[SoatResourceType]`, which is what lets a
 * generic emit helper pass its narrowed name to a function taking any event
 * name.
 */
type EventTypesByResource = {
  [R in SoatResourceType]: keyof (typeof SOAT_EVENTS)[R] & string;
};

/** The event names registered for one resource type. */
export type SoatEventTypeFor<R extends SoatResourceType> =
  EventTypesByResource[R];

/**
 * Every event name the platform itself emits. Indexed by the union of resource
 * types rather than written as `keyof SOAT_EVENTS[SoatResourceType]`, which
 * yields the keys *common* to every entry — `never`.
 */
export type SoatEventType = EventTypesByResource[SoatResourceType];

/**
 * A user-authored event name, produced only by an orchestration `emit_event`
 * node. Branded so it cannot be confused with a registered name: a platform
 * emit site cannot reach this type by writing a string literal, it has to go
 * through `emitCustomEvent`.
 */
declare const customEventBrand: unique symbol;
export type CustomEventName = string & { readonly [customEventBrand]: never };

/** The `type` an envelope on the bus can carry. */
export type SoatEventName = SoatEventType | CustomEventName;

/**
 * Every registered event name, flattened. The assertion is `Object.keys`
 * widening its result to `string[]`; the values are the registry's own keys, so
 * the narrower type is the true one.
 */
export const SOAT_EVENT_TYPES: readonly SoatEventType[] = Object.values(
  SOAT_EVENTS
).flatMap((events) => {
  return Object.keys(events) as SoatEventType[];
});

const REGISTERED = new Set<string>(SOAT_EVENT_TYPES);

/** Narrows an arbitrary string to a registered platform event name. */
export const isSoatEventType = (value: string): value is SoatEventType => {
  return REGISTERED.has(value);
};

/**
 * Marks a user-authored name as a custom event. The only producer is
 * `emitCustomEvent`; a `lib/eventTypeContract.test.ts` check keeps it that way.
 */
export const asCustomEventName = (args: { name: string }): CustomEventName => {
  return args.name as CustomEventName;
};

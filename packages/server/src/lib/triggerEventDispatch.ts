import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import type { SoatEvent } from './eventBus';
import { onEvent, recordDroppedEvent } from './eventBus';
import {
  currentCausationChain,
  MAX_EVENT_CAUSATION_DEPTH,
  runWithCausationChain,
} from './eventCausation';
import { evaluateEventPolicy, matchesEvent } from './eventMatching';
import { fileException } from './exceptions';
import { evaluateRequestQuotas, quotaBreachError } from './quotaEnforcement';
import { retryTransient } from './transientRetry';
import { createFiringRecord, finalizeFiringFailed } from './triggerFirings';

const log = createDebug('soat:triggers');

type TriggerRow = InstanceType<(typeof db)['Trigger']>;

/**
 * Why a matched trigger was not dispatched. Both refusals end the causal chain
 * rather than the trigger — the trigger stays active and fires again for the
 * next event that is not part of this chain.
 */
type Refusal = { reason: 'repeat' | 'depth'; chain: readonly string[] };

/**
 * Decides whether a matched trigger may extend the chain that led to this
 * event, or `null` when it may.
 *
 * Two independent guards, because they catch different shapes:
 *
 * - **repeat** — the chain already names this trigger, so dispatching it again
 *   is the self-feeding cycle (`agent emits → trigger runs agent → …`). Caught
 *   on the *first* recurrence rather than five hops later, which is also what
 *   keeps a `quota.exceeded` from the guard below out of its own trigger: the
 *   breach event is emitted inside the chain that already names the trigger a
 *   `*` pattern would match.
 * - **depth** — the chain is long enough that even a cycle with no repeated
 *   trigger (A → B → C → A' …) has stopped being plausible automation.
 */
const refusalFor = (args: {
  trigger: TriggerRow;
  chain: readonly string[];
}): Refusal | null => {
  const triggerId = args.trigger.publicId as string;
  if (args.chain.includes(triggerId)) {
    return { reason: 'repeat', chain: args.chain };
  }
  if (args.chain.length >= MAX_EVENT_CAUSATION_DEPTH) {
    return { reason: 'depth', chain: args.chain };
  }
  return null;
};

const refusalTitle = (args: {
  refusal: Refusal;
  trigger: TriggerRow;
}): string => {
  return args.refusal.reason === 'repeat'
    ? `Event trigger '${args.trigger.name as string}' would re-enter its own causal chain`
    : `Event trigger '${args.trigger.name as string}' exceeded the causation depth limit`;
};

/**
 * Files the `event_trigger_loop` exception for a refused dispatch. Deduped on
 * the trigger and the reason, so a loop that keeps re-arriving is one triage
 * item whose `occurrence_count` reads as how often it was refused.
 *
 * `detail` carries the chain and the event name so the wiring is diagnosable
 * from the exception alone — the events themselves are not persisted anywhere.
 */
const fileLoopException = async (args: {
  trigger: TriggerRow;
  refusal: Refusal;
  event: SoatEvent;
}): Promise<void> => {
  await fileException({
    projectId: args.trigger.projectId as number,
    kind: 'event_trigger_loop',
    title: refusalTitle({ refusal: args.refusal, trigger: args.trigger }),
    detail: {
      triggerId: args.trigger.publicId as string,
      eventType: args.event.type,
      reason: args.refusal.reason,
      causationChain: [...args.refusal.chain],
      maxDepth: MAX_EVENT_CAUSATION_DEPTH,
    },
    dedupKey: `event_trigger_loop:${args.trigger.publicId as string}:${args.refusal.reason}`,
  });
};

/**
 * Records a firing that was refused before it reached its target, so the
 * refusal is visible where an operator already looks for a trigger's history.
 * Written straight to a terminal `failed` record: `prepareFiring` is never
 * called, because nothing about the target was even resolved.
 */
const recordRefusedFiring = async (args: {
  trigger: TriggerRow;
  input: Record<string, unknown>;
  error: DomainError;
}): Promise<void> => {
  const firing = await createFiringRecord({
    triggerId: args.trigger.id as number,
    projectId: args.trigger.projectId as number,
    source: 'event',
    input: args.input,
  });
  await finalizeFiringFailed({
    firing,
    error: {
      code: args.error.code,
      message: args.error.message,
      meta: args.error.meta ?? null,
    },
  });
};

/**
 * The event payload, as the firing input. Carried opaquely: the envelope's own
 * fields are named here, and `data` is copied as a value with nothing reading a
 * key of it (`.claude/rules/case-convention.md`). Keys are snake_case because a
 * firing's `input` is a wire-visible field, and because the shape matches the
 * webhook delivery payload a loopback subscriber used to receive — so a trigger
 * migrated off the loopback keeps reading the same input.
 */
const firingInputFor = (event: SoatEvent): Record<string, unknown> => {
  return {
    event: event.type,
    project_id: event.projectPublicId,
    resource_type: event.resourceType,
    resource_id: event.resourceId,
    data: event.data,
    timestamp: event.timestamp,
  };
};

/**
 * Admits one firing against the project's `requests` quotas *before* dispatch,
 * which is the only place a cap can act: an event trigger never passes through
 * the HTTP middleware that admits every other request, so without this a `*`
 * pattern on an agent target is an uncapped spend path.
 *
 * Keyless (`apiKeyPublicId: null`) — the firing arrived on the bus, on no
 * credential — so only project-scope quotas apply. Returns the breach error to
 * record, or `null` when admitted.
 */
const admitFiring = async (args: {
  trigger: TriggerRow;
}): Promise<DomainError | null> => {
  const breach = await evaluateRequestQuotas({
    projectId: args.trigger.projectId as number,
    apiKeyPublicId: null,
  }).catch((error: unknown) => {
    // Fails open on a counter error, exactly as the request middleware does: a
    // quota is cost control, not authorization.
    log('admitFiring: failing open on counter error %O', error);
    return null;
  });

  return breach ? quotaBreachError(breach) : null;
};

/**
 * Runs one matched trigger for one event: guard, admit, dispatch.
 *
 * Everything from the guard onward runs inside the extended causation scope, so
 * an event *this* firing causes — including the `quota.exceeded` the admission
 * below may emit — arrives at the next subscriber carrying this trigger's id and
 * is refused by `refusalFor` rather than recursing.
 */
const dispatchTrigger = async (args: {
  trigger: TriggerRow;
  event: SoatEvent;
  chain: readonly string[];
}): Promise<void> => {
  const { trigger, event, chain } = args;
  const input = firingInputFor(event);

  const refusal = refusalFor({ trigger, chain });
  if (refusal) {
    log(
      'dispatchTrigger: refusing trigger=%s reason=%s chain=%o',
      trigger.publicId,
      refusal.reason,
      refusal.chain
    );
    await recordRefusedFiring({
      trigger,
      input,
      error: new DomainError(
        'TRIGGER_CAUSATION_LIMIT',
        refusalTitle({ refusal, trigger }) + '.',
        {
          reason: refusal.reason,
          causation_chain: [...refusal.chain],
          max_depth: MAX_EVENT_CAUSATION_DEPTH,
        }
      ),
    });
    await fileLoopException({ trigger, refusal, event });
    return;
  }

  await runWithCausationChain({
    chain: [...chain, trigger.publicId as string],
    fn: async () => {
      const rejected = await admitFiring({ trigger });
      if (rejected) {
        await recordRefusedFiring({ trigger, input, error: rejected });
        return;
      }

      // Imported lazily so this module — subscribed from `app.ts` — stays off
      // the orchestrations↔engine import cycle, matching `triggerScheduler.ts`.
      const { prepareFiring, runFiringDispatch } =
        await import('./triggerDispatch');
      const prepared = await prepareFiring({
        triggerPublicId: trigger.publicId as string,
        source: 'event',
        fireInput: input,
      });
      await runFiringDispatch(prepared);
    },
  });
};

/**
 * Finds the project's active event triggers whose pattern matches, and runs
 * each. Failures are per-trigger: one trigger whose creator was deleted must not
 * stop the others bound to the same event.
 */
const handleEvent = async (event: SoatEvent): Promise<void> => {
  let triggers;
  try {
    triggers = await retryTransient({
      label: 'handleEvent.triggerLookup',
      operation: () => {
        return db.Trigger.findAll({
          where: { projectId: event.projectId, type: 'event', active: true },
        });
      },
    });
  } catch (error) {
    // The one step outside the per-trigger guard below, so it is caught here
    // rather than by the subscriber: this function must never reject, or a
    // transient DB error becomes an unhandled rejection long after the write
    // that emitted the event committed.
    //
    // Never a silent `catch { return }`, for the reason #1130 established on
    // the webhook side: a blip on this one read would unhook every event
    // trigger in the project for that event, and a lost firing would be
    // indistinguishable from an event nothing subscribed to.
    recordDroppedEvent({
      stage: 'trigger_lookup',
      type: event.type,
      resourceId: event.resourceId,
      error,
    });
    return;
  }
  if (triggers.length === 0) return;

  const chain = event.causationChain ?? currentCausationChain();

  for (const trigger of triggers) {
    if (
      !matchesEvent({
        patterns: [trigger.eventPattern as string],
        eventType: event.type,
      })
    ) {
      continue;
    }

    if (trigger.policyId) {
      const allowed = await evaluateEventPolicy({
        policyId: trigger.policyId as number,
        event,
      });
      if (!allowed) continue;
    }

    await dispatchTrigger({ trigger, event, chain }).catch((error: unknown) => {
      log(
        'handleEvent: trigger=%s failed for %s %o',
        trigger.publicId,
        event.type,
        error
      );
    });
  }
};

/**
 * Subscribes the trigger module to the platform event bus, so an `event`
 * trigger starts work with no HTTP loopback in the path.
 *
 * Deliberately unfiltered, like the webhook dispatcher: an event trigger may
 * subscribe with `*` or with a user-authored name an orchestration `emit_event`
 * node produces, neither of which the registry-typed `types` filter can express.
 *
 * Exported separately from the subscription so a caller can drive one event
 * through the whole path without a live bus listener.
 *
 * `handleEvent` is total — it guards its own lookup and every trigger it
 * dispatches — so the subscriber can `void` it with no rejection handler of its
 * own, and there is no unreachable `.catch` here pretending otherwise.
 */
export const dispatchEventTriggers = handleEvent;

export const initializeTriggerEventListener = (): void => {
  onEvent({
    handler: (event) => {
      void handleEvent(event);
    },
  });
};

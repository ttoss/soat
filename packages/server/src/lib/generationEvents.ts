import createDebug from 'debug';

import { emitResourceEvent, recordDroppedEvent } from './eventBus';
import { getGeneration, type PersistedGeneration } from './generations';

const log = createDebug('soat:generation-events');

/** What a listener learns when a generation stops running. */
export type GenerationSettled = {
  generationId: string;
  /** The final text, when the generation completed. */
  assistantContent?: string;
};

type SettledListener = (args: GenerationSettled) => Promise<void>;

const settledListeners: SettledListener[] = [];

/**
 * Runs `listener` after every lifecycle event, once the record it announces is
 * written. A registry rather than an import, so the generation path does not
 * depend on the work that follows a generation. A listener never rejects.
 */
export const onGenerationSettled = (listener: SettledListener): void => {
  settledListeners.push(listener);
};

/** A pending `submit_tool_outputs` action, in its wire shape. */
export type GenerationRequiredActionWire = {
  type: string;
  tool_calls: Array<{ id: string; tool_name: string; args: unknown }>;
};

type GenerationEventFacts =
  | { type: 'generations.completed'; assistantContent: string }
  | { type: 'generations.failed' }
  | {
      type: 'generations.requires_action';
      requiredAction: GenerationRequiredActionWire;
    };

const readRecord = async (
  generationId: string
): Promise<{ record: PersistedGeneration } | { error: unknown }> => {
  try {
    const record = await getGeneration({
      publicId: generationId,
      includeUsage: true,
    });
    return record
      ? { record }
      : { error: new Error(`Generation '${generationId}' not found.`) };
  } catch (error) {
    return { error };
  }
};

/**
 * The one emit of a generation lifecycle event: `resource_id` is the
 * generation and `data` is its record as `GET /generations/{id}` answers it,
 * so it is read after the write the event announces. A paused turn's record
 * carries no pending calls, so `required_action` rides beside it.
 *
 * Never throws: a record that cannot be read is a dropped event, not a failed
 * turn.
 */
export const emitGenerationEvent = async (
  args: GenerationEventFacts & { projectId: number; generationId: string }
): Promise<void> => {
  log('emitGenerationEvent: type=%s id=%s', args.type, args.generationId);

  const read = await readRecord(args.generationId);
  if ('error' in read) {
    recordDroppedEvent({
      stage: 'generation_lookup',
      type: args.type,
      resourceId: args.generationId,
      error: read.error,
    });
    return;
  }
  const { record } = read;

  emitResourceEvent({
    type: args.type,
    projectId: args.projectId,
    projectPublicId: record.project_id,
    resourceType: 'generation',
    resourceId: record.id,
    data:
      'requiredAction' in args
        ? { ...record, required_action: args.requiredAction }
        : record,
    ...('assistantContent' in args
      ? { assistantContent: args.assistantContent }
      : {}),
  });

  for (const listener of settledListeners) {
    void listener({
      generationId: record.id,
      assistantContent:
        'assistantContent' in args ? args.assistantContent : undefined,
    });
  }
};

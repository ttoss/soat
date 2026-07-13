import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { findOrCreateActor } from './actors';
import { addConversationMessage } from './conversationMessages';
import { createConversation } from './conversations';
import {
  type DiscussionEffort,
  type DiscussionOutcome,
  type DiscussionStep,
  type DiscussionTurn,
  runDiscussionPipeline,
} from './discussionEngine';
import { findDiscussionModel } from './discussions';
import type { DiscussionModel, SynthesisConfig } from './discussionsTypes';
import { createDocument } from './documents';

const log = createDebug('soat:discussions');

const DEFAULT_PARTICIPANT_PROMPT =
  'You are a thoughtful participant in a discussion.';

const DEFAULT_SYNTHESIS_PROMPT =
  'Synthesize the discussion below into a single clear outcome. State the ' +
  'recommendation and the strongest objection to it.\n\nDiscussion:\n' +
  '${steps.deliberation}';

type Participant = NonNullable<DiscussionModel['participants']>[number];

type RunModel = InstanceType<(typeof db)['DiscussionRun']> & {
  discussion?: InstanceType<(typeof db)['Discussion']>;
  project?: InstanceType<(typeof db)['Project']>;
  conversation?: InstanceType<(typeof db)['Conversation']> | null;
  outcomeDocument?: InstanceType<(typeof db)['Document']> | null;
};

const runIncludes = () => {
  return [
    { model: db.Discussion, as: 'discussion' },
    { model: db.Project, as: 'project' },
    { model: db.Conversation, as: 'conversation' },
    { model: db.Document, as: 'outcomeDocument' },
  ];
};

const mapRunArtifacts = (run: RunModel) => {
  return {
    outcome: run.outcome ?? null,
    conversationId: run.conversation?.publicId ?? null,
    outcomeDocumentId: run.outcomeDocument?.publicId ?? null,
    startedBy: run.startedBy ?? null,
    initiatorGenerationId: run.initiatorGenerationId ?? null,
    traceId: run.traceId ?? null,
    completedAt: run.completedAt ?? null,
  };
};

const mapRun = (run: RunModel) => {
  return {
    id: run.publicId,
    discussionId: run.discussion?.publicId,
    projectId: run.project?.publicId,
    topic: run.topic,
    status: run.status,
    ...mapRunArtifacts(run),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
};

export const listDiscussionRuns = async (args: {
  discussionId: string;
  limit?: number;
  offset?: number;
}) => {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const discussion = await db.Discussion.findOne({
    where: { publicId: args.discussionId },
  });
  if (!discussion) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Discussion '${args.discussionId}' not found.`
    );
  }
  const { count, rows } = await db.DiscussionRun.findAndCountAll({
    where: { discussionId: discussion.id },
    include: runIncludes(),
    limit,
    offset,
    order: [['createdAt', 'DESC']],
  });
  return {
    data: rows.map((row) => {
      return mapRun(row as RunModel);
    }),
    total: count,
    limit,
    offset,
  };
};

export const getDiscussionRun = async (args: { id: string }) => {
  const run = await db.DiscussionRun.findOne({
    where: { publicId: args.id },
    include: runIncludes(),
  });
  if (!run) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Discussion run '${args.id}' not found.`
    );
  }
  return mapRun(run as RunModel);
};

// ── runDiscussion ─────────────────────────────────────────────────────────────

const uniqueLabel = (base: string, used: Set<string>): string => {
  let label = base;
  let suffix = 2;
  while (used.has(label)) {
    label = `${base} (${suffix})`;
    suffix += 1;
  }
  used.add(label);
  return label;
};

const buildParticipantPrompt = (persona: string | null): string => {
  return (
    `${persona ?? DEFAULT_PARTICIPANT_PROMPT}\n\n` +
    'Topic:\n${topic}\n\n' +
    'Conversation so far:\n${transcript}\n\n' +
    'Respond with your perspective.'
  );
};

const sortedParticipants = (discussion: DiscussionModel): Participant[] => {
  return (discussion.participants ?? []).slice().sort((a, b) => {
    return a.position - b.position;
  });
};

/** Stable, unique labels per participant, for transcript attribution. */
const buildLabels = (
  participants: Participant[]
): { labels: Map<string, string>; labelToParticipant: Map<string, string> } => {
  const used = new Set<string>();
  const labels = new Map<string, string>();
  const labelToParticipant = new Map<string, string>();
  for (const [index, participant] of participants.entries()) {
    const base =
      participant.name ?? participant.actor?.name ?? `Participant ${index + 1}`;
    const label = uniqueLabel(base, used);
    labels.set(participant.publicId, label);
    labelToParticipant.set(label, participant.publicId);
  }
  return { labels, labelToParticipant };
};

const toBranch = (participant: Participant, label?: string) => {
  return {
    name: label,
    prompt: buildParticipantPrompt(participant.prompt),
    aiProviderId: participant.aiProvider?.publicId,
    model: participant.model ?? undefined,
    temperature: participant.temperature ?? undefined,
    effort: (participant.effort as DiscussionEffort | null) ?? undefined,
  };
};

const synthesisStep = (synthesis: SynthesisConfig | null): DiscussionStep => {
  return {
    name: 'synthesis',
    output: true,
    prompt: synthesis?.prompt ?? DEFAULT_SYNTHESIS_PROMPT,
    aiProviderId: synthesis?.aiProviderId,
    model: synthesis?.model ?? undefined,
    effort: synthesis?.effort ?? undefined,
  };
};

const buildSteps = (args: {
  discussion: DiscussionModel;
  labels: Map<string, string>;
}): DiscussionStep[] => {
  const participants = sortedParticipants(args.discussion);
  const deliberation: DiscussionStep = {
    name: 'deliberation',
    branches: participants.map((participant) => {
      return toBranch(participant, args.labels.get(participant.publicId));
    }),
    rounds: args.discussion.maxRounds,
  };

  const synthesis = args.discussion.synthesis as SynthesisConfig | null;
  const needsSynthesis =
    participants.length > 1 || args.discussion.maxRounds > 1 || !!synthesis;
  return needsSynthesis
    ? [deliberation, synthesisStep(synthesis)]
    : [deliberation];
};

const findConversationDbId = async (
  publicId: string
): Promise<number | null> => {
  const conversation = await db.Conversation.findOne({ where: { publicId } });
  return (conversation?.id as number | undefined) ?? null;
};

const findDocumentDbId = async (publicId: string): Promise<number | null> => {
  const document = await db.Document.findOne({ where: { publicId } });
  return (document?.id as number | undefined) ?? null;
};

const persistTurns = async (args: {
  discussion: DiscussionModel;
  projectId: number;
  conversationPublicId: string;
  turns: DiscussionTurn[];
  labelToParticipant: Map<string, string>;
}): Promise<void> => {
  const actorCache = new Map<string, string>();
  for (const turn of args.turns) {
    let actorPublicId: string | null = null;
    const participantPublicId = args.labelToParticipant.get(turn.name);
    if (participantPublicId) {
      if (!actorCache.has(participantPublicId)) {
        const { actor } = await findOrCreateActor({
          projectId: args.projectId,
          externalId: `discussion:${args.discussion.publicId}:participant:${participantPublicId}`,
          name: turn.name,
        });
        actorCache.set(participantPublicId, actor.id);
      }
      actorPublicId = actorCache.get(participantPublicId) ?? null;
    }
    await addConversationMessage({
      conversationId: args.conversationPublicId,
      message: turn.text,
      role: 'assistant',
      actorId: actorPublicId,
      metadata: { step: turn.step, round: turn.round, name: turn.name },
    });
  }
};

/**
 * Persists the transcript as a Conversation with Actor authorship and the
 * outcome as a Document. Best-effort — a persistence failure must not fail the
 * run, since the outcome text (the tool-result contract) already exists.
 */
const persistRun = async (args: {
  discussion: DiscussionModel;
  projectId: number;
  turns: DiscussionTurn[];
  outcome: string;
  labelToParticipant: Map<string, string>;
}): Promise<{ conversationId: number | null; documentId: number | null }> => {
  try {
    const conversation = await createConversation({
      projectId: args.projectId,
      name: `Discussion: ${args.discussion.name}`,
    });
    await persistTurns({
      discussion: args.discussion,
      projectId: args.projectId,
      conversationPublicId: conversation.id,
      turns: args.turns,
      labelToParticipant: args.labelToParticipant,
    });
    const document = await createDocument({
      projectId: args.projectId,
      content: args.outcome,
      title: `Discussion outcome: ${args.discussion.name}`,
      filename: 'outcome.txt',
    });
    return {
      conversationId: await findConversationDbId(conversation.id),
      documentId: await findDocumentDbId(document.id),
    };
  } catch (error) {
    log(
      'persistRun: transcript/outcome persistence failed error=%s',
      error instanceof Error ? error.message : String(error)
    );
    return { conversationId: null, documentId: null };
  }
};

const loadDiscussionForRun = async (
  discussionId: string
): Promise<DiscussionModel> => {
  const discussion = await findDiscussionModel(discussionId);
  if (!discussion) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Discussion '${discussionId}' not found.`
    );
  }
  if (!discussion.aiProvider) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `Discussion '${discussionId}' has no AI provider.`
    );
  }
  return discussion;
};

/**
 * Invokes a discussion: builds a deliberation (participants → branches) plus an
 * optional synthesis, runs the engine, persists the transcript + outcome, and
 * records a `DiscussionRun`. Synchronous — the caller (e.g. a `discussion` tool)
 * blocks for the full run, bounded by the engine caps and timeouts.
 */
export const runDiscussion = async (args: {
  discussionId: string;
  topic: string;
  startedBy?: Record<string, unknown> | null;
  initiatorGenerationId?: string | null;
}) => {
  log('runDiscussion: discussionId=%s', args.discussionId);

  const discussion = await loadDiscussionForRun(args.discussionId);
  const projectId = discussion.projectId as number;

  const run = await db.DiscussionRun.create({
    discussionId: discussion.id,
    projectId,
    topic: args.topic,
    status: 'running',
    startedBy: args.startedBy ?? null,
    initiatorGenerationId: args.initiatorGenerationId ?? null,
  });

  const participants = sortedParticipants(discussion);
  const { labels, labelToParticipant } = buildLabels(participants);
  const steps = buildSteps({ discussion, labels });

  const outcome: DiscussionOutcome = await runDiscussionPipeline({
    projectId,
    defaultAiProviderId: discussion.aiProvider!.publicId,
    defaultModel: discussion.model,
    steps,
    topic: args.topic,
  });

  const status = outcome.text.trim().length > 0 ? 'completed' : 'failed';
  const persisted =
    status === 'completed'
      ? await persistRun({
          discussion,
          projectId,
          turns: outcome.turns,
          outcome: outcome.text,
          labelToParticipant,
        })
      : { conversationId: null, documentId: null };

  await run.update({
    status,
    outcome: outcome.text,
    conversationId: persisted.conversationId,
    outcomeDocumentId: persisted.documentId,
    completedAt: new Date(),
  });

  const finished = await db.DiscussionRun.findOne({
    where: { id: run.id },
    include: runIncludes(),
  });
  return mapRun(finished as RunModel);
};

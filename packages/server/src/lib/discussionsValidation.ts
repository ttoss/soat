import { DomainError } from '../errors';
import {
  type DiscussionEffort,
  MAX_PARTICIPANTS,
  MAX_ROUNDS,
} from './discussionEngine';
import type { ParticipantInput, SynthesisConfig } from './discussionsTypes';

const EFFORTS = new Set<DiscussionEffort>(['low', 'medium', 'high']);

const assertEffort = (value: unknown, where: string): void => {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !EFFORTS.has(value as DiscussionEffort)) {
    throw new DomainError(
      'INVALID_DISCUSSION_CONFIG',
      `${where} effort must be one of low, medium, high.`
    );
  }
};

const validateMaxRounds = (maxRounds?: number | null): void => {
  if (maxRounds === undefined || maxRounds === null) return;
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS) {
    throw new DomainError(
      'INVALID_DISCUSSION_CONFIG',
      `max_rounds must be an integer between 1 and ${MAX_ROUNDS}.`
    );
  }
};

const validateParticipantsList = (participants: ParticipantInput[]): void => {
  if (participants.length < 1) {
    throw new DomainError(
      'INVALID_DISCUSSION_CONFIG',
      'A discussion requires at least one participant.'
    );
  }
  if (participants.length > MAX_PARTICIPANTS) {
    throw new DomainError(
      'INVALID_DISCUSSION_CONFIG',
      `A discussion allows at most ${MAX_PARTICIPANTS} participants.`
    );
  }
  for (const participant of participants) {
    assertEffort(participant.effort, 'participant');
  }
};

/**
 * Validates the transport-independent business rules of a discussion config.
 * Reused by the REST route and the formation module so the two never diverge.
 */
export const validateDiscussionConfig = (args: {
  maxRounds?: number | null;
  participants?: ParticipantInput[];
  synthesis?: SynthesisConfig | null;
}): void => {
  validateMaxRounds(args.maxRounds);
  if (args.participants !== undefined) {
    validateParticipantsList(args.participants);
  }
  if (args.synthesis) {
    assertEffort(args.synthesis.effort, 'synthesis');
  }
};

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

// ── Prompt template token warnings ──────────────────────────────────────────
//
// A discussion always compiles down to at most two engine steps — the fixed
// `deliberation` step (one branch per participant) followed by an optional
// `synthesis` step — so `deliberation` is the only step a prompt can ever
// legitimately reference (see `discussionRuns.ts` `buildSteps`). Any other
// `{token}` is either a typo or a token copied from a different templating
// system; it is not rejected (unknown tokens pass through `resolveTemplate`
// unresolved, which is harmless), just surfaced as a warning.

const PROMPT_TOKEN_RE = /\{([\w.]+)\}/g;
const ALWAYS_ALLOWED_TOKENS = new Set(['topic', 'transcript']);
const ALLOWED_STEP_REFS = new Set([
  'steps.deliberation',
  'steps.deliberation.last',
]);

const findPromptTokenWarnings = (args: {
  prompt: string;
  where: string;
}): string[] => {
  const warnings: string[] = [];
  for (const match of args.prompt.matchAll(PROMPT_TOKEN_RE)) {
    const token = match[1] as string;
    if (ALWAYS_ALLOWED_TOKENS.has(token) || ALLOWED_STEP_REFS.has(token)) {
      continue;
    }
    warnings.push(
      `${args.where} references unknown template token '{${token}}' — allowed tokens are {topic}, {transcript}, {steps.deliberation}, and {steps.deliberation.last}.`
    );
  }
  return warnings;
};

/**
 * Collects non-blocking warnings for `{token}` references in participant and
 * synthesis prompts that fall outside the allowlist `resolveTemplate` actually
 * resolves. Pure and side-effect free — safe to call on every read, not just
 * at write time.
 */
export const findDiscussionTemplateWarnings = (args: {
  participants?: Array<{ prompt?: string | null }>;
  synthesis?: SynthesisConfig | null;
}): string[] => {
  const warnings: string[] = [];
  for (const [index, participant] of (args.participants ?? []).entries()) {
    if (!participant.prompt) continue;
    warnings.push(
      ...findPromptTokenWarnings({
        prompt: participant.prompt,
        where: `participants[${index}].prompt`,
      })
    );
  }
  if (args.synthesis?.prompt) {
    warnings.push(
      ...findPromptTokenWarnings({
        prompt: args.synthesis.prompt,
        where: 'synthesis.prompt',
      })
    );
  }
  return warnings;
};

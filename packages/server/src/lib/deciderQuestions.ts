import { DomainError } from '../errors';

/**
 * A decider's question set, validated on write.
 *
 * Every rule here is one the model would otherwise enforce at evaluation time,
 * in an upstream `400` a caller reads long after the decider was saved. A
 * question set is configuration, so it is checked once when stored rather than
 * on every evaluation.
 */
export const QUESTION_TYPES = ['choice', 'score', 'noul'] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

/** A Choice with one option, or a Score with one level, has no judgment to make. */
const MIN_CRITERIA = 2;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isQuestionType = (value: unknown): value is QuestionType => {
  return QUESTION_TYPES.some((type) => {
    return type === value;
  });
};

const fail = (message: string): never => {
  throw new DomainError('VALIDATION_FAILED', message);
};

const assertChoiceCriteria = (args: { id: string; criteria: unknown }) => {
  if (!isRecord(args.criteria)) {
    fail(
      `Question \`${args.id}\`: a choice question needs \`criteria\` as an object mapping each option to its description.`
    );
    return;
  }
  const options = Object.entries(args.criteria);
  if (options.length < MIN_CRITERIA) {
    fail(
      `Question \`${args.id}\`: a choice question needs at least ${MIN_CRITERIA} options.`
    );
  }
  for (const [option, description] of options) {
    if (typeof description !== 'string' || !description.trim()) {
      fail(
        `Question \`${args.id}\`: option \`${option}\` needs a non-empty description.`
      );
    }
  }
};

const assertScoreCriteria = (args: { id: string; criteria: unknown }) => {
  if (!Array.isArray(args.criteria)) {
    fail(
      `Question \`${args.id}\`: a score question needs \`criteria\` as an ordered array of level descriptions.`
    );
    return;
  }
  if (args.criteria.length < MIN_CRITERIA) {
    fail(
      `Question \`${args.id}\`: a score question needs at least ${MIN_CRITERIA} levels.`
    );
  }
  for (const level of args.criteria) {
    if (typeof level !== 'string' || !level.trim()) {
      fail(
        `Question \`${args.id}\`: every score level must be a non-empty string.`
      );
    }
  }
};

const assertQuestion = (args: { id: string; question: unknown }) => {
  if (!isRecord(args.question)) {
    fail(`Question \`${args.id}\` must be an object.`);
    return;
  }

  if (!isQuestionType(args.question.type)) {
    fail(
      `Question \`${args.id}\`: \`type\` must be one of ${QUESTION_TYPES.join(', ')}.`
    );
    return;
  }

  if (
    typeof args.question.instructions !== 'string' ||
    !args.question.instructions.trim()
  ) {
    fail(`Question \`${args.id}\`: \`instructions\` is required.`);
  }

  if (args.question.type === 'choice') {
    assertChoiceCriteria({ id: args.id, criteria: args.question.criteria });
  }

  if (args.question.type === 'score') {
    assertScoreCriteria({ id: args.id, criteria: args.question.criteria });
  }

  // A Noul's `criteria` is an optional clarification of what yes and no mean,
  // so it is only checked when present.
  if (
    args.question.type === 'noul' &&
    args.question.criteria !== undefined &&
    !isRecord(args.question.criteria)
  ) {
    fail(
      `Question \`${args.id}\`: a noul question's \`criteria\` must be an object describing yes and no.`
    );
  }
};

export const validateQuestions = (questions: unknown): object => {
  if (!isRecord(questions)) {
    fail('`questions` must be an object keyed by question id.');
    return {};
  }

  const entries = Object.entries(questions);
  if (entries.length === 0) {
    fail('`questions` must carry at least one question.');
  }

  for (const [id, question] of entries) {
    assertQuestion({ id, question });
  }

  return questions;
};

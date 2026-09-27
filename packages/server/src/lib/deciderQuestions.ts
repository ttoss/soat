import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';

/**
 * A decider's question set: the validation every write runs, the JSON Schema
 * an answer must satisfy, and the mapping from a validated answer to the
 * decision's `answers`.
 *
 * Every question declares a finite answer space, and the compiled schema is
 * what confines an answer to it, whichever backend produced it.
 */

export type ChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
};

export type ScoreQuestion = {
  type: 'score';
  instructions: string;
  criteria: string[];
};

export type BooleanQuestion = {
  type: 'boolean';
  instructions: string;
  criteria?: { false: string; true: string };
};

export type DeciderQuestion = ChoiceQuestion | ScoreQuestion | BooleanQuestion;

/** The usage `source` a decider's generation carries. */
export const DECIDER_USAGE_SOURCE = 'decider';

export type DeciderQuestions = Record<string, DeciderQuestion>;

/**
 * `probabilities` is a distribution over the answer space, set only when a
 * tool backend supplies one. SOAT carries it and does not vouch for it.
 */
export type DecisionAnswer = (
  | { type: 'choice'; choice: string }
  | { type: 'score'; score: number; legend: string }
  | { type: 'boolean'; value: boolean }
) & { probabilities?: Record<string, number> };

/**
 * A question id is a JSON Schema property name and a JSON Logic `var` path
 * segment, so it may not hold a dot.
 */
const QUESTION_ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const MAX_QUESTIONS = 20;

/** With one member there is no judgment to make. */
const MIN_ANSWERS = 2;

const MAX_ANSWERS = 20;

const QUESTION_FIELDS = new Set(['type', 'instructions', 'criteria']);

const invalid = (message: string): DomainError => {
  return new DomainError('VALIDATION_FAILED', message);
};

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim() !== '';
};

const assertAnswerCount = (args: { id: string; count: number }): void => {
  if (args.count < MIN_ANSWERS || args.count > MAX_ANSWERS) {
    throw invalid(
      `questions.${args.id}.criteria must declare between ${MIN_ANSWERS} and ${MAX_ANSWERS} answers.`
    );
  }
};

const parseChoiceCriteria = (args: {
  id: string;
  criteria: unknown;
}): Record<string, string> => {
  if (!isPlainObject(args.criteria)) {
    throw invalid(
      `questions.${args.id}.criteria must map each option to its description.`
    );
  }
  const entries = Object.entries(args.criteria);
  assertAnswerCount({ id: args.id, count: entries.length });

  const criteria: Record<string, string> = {};
  for (const [option, description] of entries) {
    if (!isNonEmptyString(option) || !isNonEmptyString(description)) {
      throw invalid(
        `questions.${args.id}.criteria options and descriptions must be non-empty strings.`
      );
    }
    criteria[option] = description;
  }
  return criteria;
};

const parseScoreCriteria = (args: {
  id: string;
  criteria: unknown;
}): string[] => {
  if (!Array.isArray(args.criteria)) {
    throw invalid(
      `questions.${args.id}.criteria must list the levels in order.`
    );
  }
  assertAnswerCount({ id: args.id, count: args.criteria.length });

  return args.criteria.map((level) => {
    if (!isNonEmptyString(level)) {
      throw invalid(
        `questions.${args.id}.criteria levels must be non-empty strings.`
      );
    }
    return level;
  });
};

const parseBooleanCriteria = (args: {
  id: string;
  criteria: unknown;
}): { false: string; true: string } | undefined => {
  if (args.criteria === undefined) return undefined;

  const keys = isPlainObject(args.criteria)
    ? Object.keys(args.criteria).sort()
    : [];
  if (
    !isPlainObject(args.criteria) ||
    keys.length !== 2 ||
    keys[0] !== 'false' ||
    keys[1] !== 'true' ||
    !isNonEmptyString(args.criteria.false) ||
    !isNonEmptyString(args.criteria.true)
  ) {
    throw invalid(
      `questions.${args.id}.criteria must describe exactly false and true.`
    );
  }
  return { false: args.criteria.false, true: args.criteria.true };
};

const parseQuestion = (args: {
  id: string;
  question: unknown;
}): DeciderQuestion => {
  const { id, question } = args;

  if (!QUESTION_ID.test(id)) {
    throw invalid(
      `Question id '${id}' must start with a letter or underscore and hold only letters, digits and underscores (at most 64).`
    );
  }
  if (!isPlainObject(question)) {
    throw invalid(`questions.${id} must be an object.`);
  }
  for (const field of Object.keys(question)) {
    if (!QUESTION_FIELDS.has(field)) {
      throw invalid(`questions.${id}.${field} is not a question field.`);
    }
  }
  if (!isNonEmptyString(question.instructions)) {
    throw invalid(`questions.${id}.instructions must be a non-empty string.`);
  }

  const { instructions, criteria } = question;
  switch (question.type) {
    case 'choice':
      return {
        type: 'choice',
        instructions,
        criteria: parseChoiceCriteria({ id, criteria }),
      };
    case 'score':
      return {
        type: 'score',
        instructions,
        criteria: parseScoreCriteria({ id, criteria }),
      };
    case 'boolean': {
      const parsed = parseBooleanCriteria({ id, criteria });
      return parsed === undefined
        ? { type: 'boolean', instructions }
        : { type: 'boolean', instructions, criteria: parsed };
    }
    default:
      throw invalid(
        `questions.${id}.type must be one of choice, score or boolean.`
      );
  }
};

/**
 * Validates a question set and returns it in canonical form, keeping the
 * caller's order of questions and of each question's options.
 */
export const parseDeciderQuestions = (value: unknown): DeciderQuestions => {
  if (!isPlainObject(value)) {
    throw invalid('questions must be an object keyed by question id.');
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_QUESTIONS) {
    throw invalid(
      `questions must declare between 1 and ${MAX_QUESTIONS} questions.`
    );
  }

  const questions: DeciderQuestions = {};
  for (const [id, question] of entries) {
    questions[id] = parseQuestion({ id, question });
  }
  return questions;
};

const answerSchema = (question: DeciderQuestion): Record<string, unknown> => {
  switch (question.type) {
    case 'choice':
      return { type: 'string', enum: Object.keys(question.criteria) };
    case 'score':
      return {
        type: 'integer',
        minimum: 0,
        maximum: question.criteria.length - 1,
      };
    case 'boolean':
      return { type: 'boolean' };
  }
};

/**
 * The JSON Schema an answer object must satisfy: one property per question,
 * each confined to that question's answer space, all required, nothing else.
 */
export const compileAnswerSchema = (
  questions: DeciderQuestions
): Record<string, unknown> => {
  const properties: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    properties[id] = answerSchema(question);
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(questions),
    properties,
  };
};

/**
 * Maps an answer object that already satisfies {@link compileAnswerSchema} to
 * the decision's `answers`, deriving each score's `legend` from the criteria.
 */
export const toDecisionAnswers = (args: {
  questions: DeciderQuestions;
  answer: Record<string, unknown>;
}): Record<string, DecisionAnswer> => {
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(args.questions)) {
    const value = args.answer[id];
    switch (question.type) {
      case 'choice':
        answers[id] = { type: 'choice', choice: String(value) };
        break;
      case 'score': {
        const score = Number(value);
        answers[id] = {
          type: 'score',
          score,
          legend: question.criteria[score],
        };
        break;
      }
      case 'boolean':
        answers[id] = { type: 'boolean', value: value === true };
        break;
    }
  }
  return answers;
};

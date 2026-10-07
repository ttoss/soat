import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';

/**
 * A decider's question set: the validation every write runs, the JSON Schema
 * an agent's answer must satisfy, and the mapping from that answer to the
 * decision's `answers`.
 *
 * The question and answer shapes are those of OpenAI's Decisions API, so a
 * tool that forwards to it, or to any engine speaking the same shape, answers
 * a decider with no mapping.
 */

export type PredicateQuestion = {
  type: 'predicate';
  name: string;
  instructions: string;
};

export type DeciderChoice = { value: string; description: string };

export type ChoiceQuestion = {
  type: 'choice';
  name: string;
  instructions: string;
  choices: DeciderChoice[];
};

export type DeciderLevel = { label: string; description: string };

export type ScoreQuestion = {
  type: 'score';
  name: string;
  instructions: string;
  levels: DeciderLevel[];
};

export type DeciderQuestion =
  PredicateQuestion | ChoiceQuestion | ScoreQuestion;

export type DeciderQuestions = DeciderQuestion[];

/** The usage `source` a decider's generation carries. */
export const DECIDER_USAGE_SOURCE = 'decider';

export type ChoiceProbability = { value: string; probability: number };

export type LevelProbability = {
  value: number;
  label: string;
  probability: number;
};

/**
 * `probabilities` and `confidence` are set only when a tool backend supplies
 * them. SOAT carries them and does not vouch for them.
 */
export type DecisionAnswer =
  | { type: 'predicate'; name: string; probability: number }
  | {
      type: 'choice';
      name: string;
      choice: string;
      probabilities?: ChoiceProbability[];
      confidence?: number;
    }
  | {
      type: 'score';
      name: string;
      score: number;
      probabilities?: LevelProbability[];
      confidence?: number;
    };

/**
 * A question name is a JSON Schema property name and a JSON Logic `var` path
 * segment, so it may not hold a dot.
 */
const QUESTION_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const MAX_QUESTIONS = 20;

/** With one member there is no judgment to make. */
const MIN_ANSWERS = 2;

const MAX_ANSWERS = 20;

const QUESTION_FIELDS: Record<DeciderQuestion['type'], ReadonlySet<string>> = {
  predicate: new Set(['type', 'name', 'instructions']),
  choice: new Set(['type', 'name', 'instructions', 'choices']),
  score: new Set(['type', 'name', 'instructions', 'levels']),
};

const invalid = (message: string): DomainError => {
  return new DomainError('VALIDATION_FAILED', message);
};

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim() !== '';
};

/** Reads `items` as 2–20 objects holding exactly `keys`, each a string. */
const parseMembers = <K extends string>(args: {
  path: string;
  items: unknown;
  keys: readonly [K, K];
}): Record<K, string>[] => {
  const { path, items, keys } = args;
  if (!Array.isArray(items)) {
    throw invalid(`${path} must be an array.`);
  }
  if (items.length < MIN_ANSWERS || items.length > MAX_ANSWERS) {
    throw invalid(
      `${path} must declare between ${MIN_ANSWERS} and ${MAX_ANSWERS} entries.`
    );
  }
  return items.map((item, index) => {
    const at = `${path}[${index}]`;
    if (!isPlainObject(item)) throw invalid(`${at} must be an object.`);
    for (const field of Object.keys(item)) {
      if (
        !keys.some((key) => {
          return key === field;
        })
      ) {
        throw invalid(`${at}.${field} is not a field of this entry.`);
      }
    }
    const member = {} as Record<K, string>;
    for (const key of keys) {
      const value = item[key];
      if (!isNonEmptyString(value)) {
        throw invalid(`${at}.${key} must be a non-empty string.`);
      }
      member[key] = value;
    }
    return member;
  });
};

const parseChoices = (args: {
  path: string;
  choices: unknown;
}): DeciderChoice[] => {
  const choices = parseMembers({
    path: `${args.path}.choices`,
    items: args.choices,
    keys: ['value', 'description'],
  });
  const seen = new Set<string>();
  for (const { value } of choices) {
    if (seen.has(value)) {
      throw invalid(`${args.path}.choices holds '${value}' twice.`);
    }
    seen.add(value);
  }
  return choices;
};

/** The fields every question type shares, validated. */
const readQuestionHeader = (args: {
  path: string;
  question: unknown;
}): Pick<DeciderQuestion, 'type' | 'name' | 'instructions'> & {
  question: Record<string, unknown>;
} => {
  const { path, question } = args;
  if (!isPlainObject(question)) {
    throw invalid(`${path} must be an object.`);
  }
  const { type, name, instructions } = question;
  if (type !== 'predicate' && type !== 'choice' && type !== 'score') {
    throw invalid(`${path}.type must be one of predicate, choice or score.`);
  }
  for (const field of Object.keys(question)) {
    if (!QUESTION_FIELDS[type].has(field)) {
      throw invalid(`${path}.${field} is not a field of a ${type} question.`);
    }
  }
  if (typeof name !== 'string' || !QUESTION_NAME.test(name)) {
    throw invalid(
      `${path}.name must start with a letter or underscore and hold only letters, digits and underscores (at most 64).`
    );
  }
  if (!isNonEmptyString(instructions)) {
    throw invalid(`${path}.instructions must be a non-empty string.`);
  }
  return { type, name, instructions, question };
};

const parseQuestion = (args: {
  path: string;
  question: unknown;
}): DeciderQuestion => {
  const { path } = args;
  const { type, name, instructions, question } = readQuestionHeader(args);
  switch (type) {
    case 'predicate':
      return { type, name, instructions };
    case 'choice':
      return {
        type,
        name,
        instructions,
        choices: parseChoices({ path, choices: question.choices }),
      };
    case 'score':
      return {
        type,
        name,
        instructions,
        levels: parseMembers({
          path: `${path}.levels`,
          items: question.levels,
          keys: ['label', 'description'],
        }),
      };
  }
};

/**
 * Validates a question set and returns it in canonical form, keeping the
 * caller's order of questions, choices and levels.
 */
export const parseDeciderQuestions = (value: unknown): DeciderQuestions => {
  if (!Array.isArray(value)) {
    throw invalid('questions must be an array.');
  }
  if (value.length === 0 || value.length > MAX_QUESTIONS) {
    throw invalid(
      `questions must declare between 1 and ${MAX_QUESTIONS} questions.`
    );
  }

  const names = new Set<string>();
  return value.map((question, index) => {
    const parsed = parseQuestion({ path: `questions[${index}]`, question });
    if (names.has(parsed.name)) {
      throw invalid(`questions holds the name '${parsed.name}' twice.`);
    }
    names.add(parsed.name);
    return parsed;
  });
};

/**
 * What an agent answers each question with. A model emits no calibrated
 * probability, so a predicate is answered true or false and recorded as 1 or 0.
 */
const agentAnswerSchema = (
  question: DeciderQuestion
): Record<string, unknown> => {
  switch (question.type) {
    case 'predicate':
      return { type: 'boolean' };
    case 'choice':
      return {
        type: 'string',
        enum: question.choices.map((choice) => {
          return choice.value;
        }),
      };
    case 'score':
      return {
        type: 'integer',
        minimum: 0,
        maximum: question.levels.length - 1,
      };
  }
};

/**
 * The JSON Schema an agent's answer object must satisfy: one property per
 * question name, each confined to that question's answer space, all required,
 * nothing else.
 */
export const compileAnswerSchema = (
  questions: DeciderQuestions
): Record<string, unknown> => {
  const properties: Record<string, unknown> = {};
  for (const question of questions) {
    properties[question.name] = agentAnswerSchema(question);
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: questions.map((question) => {
      return question.name;
    }),
    properties,
  };
};

/**
 * Maps an agent answer object that already satisfies
 * {@link compileAnswerSchema} to the decision's `answers`, in question order.
 */
export const toDecisionAnswers = (args: {
  questions: DeciderQuestions;
  answer: Record<string, unknown>;
}): DecisionAnswer[] => {
  return args.questions.map((question): DecisionAnswer => {
    const value = args.answer[question.name];
    const { name } = question;
    switch (question.type) {
      case 'predicate':
        return { type: 'predicate', name, probability: value === true ? 1 : 0 };
      case 'choice':
        return { type: 'choice', name, choice: String(value) };
      case 'score':
        return { type: 'score', name, score: Number(value) };
    }
  });
};

/**
 * The answers keyed by question name, so a JSON Logic path reads an answer by
 * name rather than by its position in the question set.
 */
export const answersByName = (
  answers: unknown
): Record<string, unknown> | null => {
  if (!Array.isArray(answers)) return null;
  const byName: Record<string, unknown> = {};
  for (const answer of answers) {
    if (isPlainObject(answer) && typeof answer.name === 'string') {
      byName[answer.name] = answer;
    }
  }
  return byName;
};

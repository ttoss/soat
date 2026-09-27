import { DomainError } from '../errors';
import type {
  DeciderQuestion,
  DeciderQuestions,
  DecisionAnswer,
} from './deciderQuestions';
import { isPlainObject } from './plainObject';

/**
 * The contract a decider's tool answers in:
 * `{ answers: { <question id>: { choice | score | value, type?, probabilities? } } }`.
 *
 * Strict on `answers`, since it is what the decision stores: every question
 * answered, no other id, no field the contract does not define, so it cannot
 * grow by a backend's habit. Keys beside `answers` are never read.
 */

const invalid = (message: string): DomainError => {
  return new DomainError('DECISION_ANSWER_INVALID', message);
};

const ANSWER_FIELDS: Record<DeciderQuestion['type'], ReadonlySet<string>> = {
  choice: new Set(['type', 'choice', 'probabilities']),
  // `legend` is accepted from engines that echo it, and replaced by the one
  // the decider's own criteria name.
  score: new Set(['type', 'score', 'legend', 'probabilities']),
  boolean: new Set(['type', 'value', 'probabilities']),
};

/** The members of a question's answer space, as `probabilities` keys them. */
const spaceOf = (question: DeciderQuestion): string[] => {
  switch (question.type) {
    case 'choice':
      return Object.keys(question.criteria);
    case 'score':
      return question.criteria.map((_level, index) => {
        return String(index);
      });
    case 'boolean':
      return ['false', 'true'];
  }
};

/** An object parsed from the tool's result: as returned, or from its text. */
const envelopeOf = (raw: unknown): Record<string, unknown> => {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  if (!isPlainObject(parsed)) {
    throw invalid('The tool did not answer with a JSON object.');
  }
  return parsed;
};

const readProbabilities = (args: {
  path: string;
  question: DeciderQuestion;
  probabilities: unknown;
}): Record<string, number> => {
  const { path, probabilities } = args;
  if (!isPlainObject(probabilities)) {
    throw invalid(`${path}.probabilities must be an object.`);
  }
  const space = new Set(spaceOf(args.question));
  const read: Record<string, number> = {};
  for (const [member, probability] of Object.entries(probabilities)) {
    if (!space.has(member)) {
      throw invalid(
        `${path}.probabilities.${member} names no member of the answer space.`
      );
    }
    if (
      typeof probability !== 'number' ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      throw invalid(`${path}.probabilities.${member} must be a number in 0–1.`);
    }
    read[member] = probability;
  }
  return read;
};

/** The score as a level index of the question, or null when it is not one. */
const levelIndexOf = (args: {
  score: unknown;
  levels: number;
}): number | null => {
  const { score } = args;
  return typeof score === 'number' &&
    Number.isInteger(score) &&
    score >= 0 &&
    score < args.levels
    ? score
    : null;
};

const readValue = (args: {
  path: string;
  question: DeciderQuestion;
  answer: Record<string, unknown>;
}): DecisionAnswer => {
  const { path, question, answer } = args;
  switch (question.type) {
    case 'choice': {
      const { choice } = answer;
      if (typeof choice !== 'string' || !(choice in question.criteria)) {
        throw invalid(`${path}.choice must be one of the question's options.`);
      }
      return { type: 'choice', choice };
    }
    case 'score': {
      const score = levelIndexOf({
        score: answer.score,
        levels: question.criteria.length,
      });
      if (score === null) {
        throw invalid(`${path}.score must be a level index.`);
      }
      return { type: 'score', score, legend: question.criteria[score] };
    }
    case 'boolean': {
      const { value } = answer;
      if (typeof value !== 'boolean') {
        throw invalid(`${path}.value must be a boolean.`);
      }
      return { type: 'boolean', value };
    }
  }
};

const readAnswer = (args: {
  id: string;
  question: DeciderQuestion;
  answer: unknown;
}): DecisionAnswer => {
  const { question, answer } = args;
  const path = `answers.${args.id}`;
  if (!isPlainObject(answer)) throw invalid(`${path} must be an object.`);
  for (const field of Object.keys(answer)) {
    if (!ANSWER_FIELDS[question.type].has(field)) {
      throw invalid(`${path}.${field} is not part of the answer contract.`);
    }
  }
  if (answer.type !== undefined && answer.type !== question.type) {
    throw invalid(`${path}.type must be '${question.type}'.`);
  }
  const read = readValue({ path, question, answer });
  if (answer.probabilities === undefined) return read;
  return {
    ...read,
    probabilities: readProbabilities({
      path,
      question,
      probabilities: answer.probabilities,
    }),
  };
};

/** Reads a tool's answer to the question set, or throws naming why not. */
export const parseToolAnswers = (args: {
  questions: DeciderQuestions;
  raw: unknown;
}): Record<string, DecisionAnswer> => {
  const { answers } = envelopeOf(args.raw);
  if (!isPlainObject(answers)) {
    throw invalid('The tool answer carries no answers object.');
  }
  for (const id of Object.keys(answers)) {
    if (!(id in args.questions)) {
      throw invalid(`answers.${id} names no question.`);
    }
  }
  const read: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(args.questions)) {
    if (!(id in answers)) throw invalid(`answers.${id} is missing.`);
    read[id] = readAnswer({ id, question, answer: answers[id] });
  }
  return read;
};

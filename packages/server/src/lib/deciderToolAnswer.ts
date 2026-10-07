import { DomainError } from '../errors';
import type {
  ChoiceProbability,
  ChoiceQuestion,
  DeciderQuestion,
  DeciderQuestions,
  DecisionAnswer,
  LevelProbability,
  ScoreQuestion,
} from './deciderQuestions';
import { isPlainObject } from './plainObject';

/**
 * The contract a decider's tool answers in, OpenAI's Decisions API response:
 * `{ answers: [{ type?, name, probability | choice | score, probabilities?, confidence? }] }`.
 *
 * Strict on `answers`, since it is what the decision stores: every question
 * answered once, no other name, no field the contract does not define, so it
 * cannot grow by a backend's habit. Keys beside `answers` are never read.
 */

const invalid = (message: string): DomainError => {
  return new DomainError('DECISION_ANSWER_INVALID', message);
};

const ANSWER_FIELDS: Record<DeciderQuestion['type'], ReadonlySet<string>> = {
  predicate: new Set(['type', 'name', 'probability']),
  choice: new Set(['type', 'name', 'choice', 'probabilities', 'confidence']),
  score: new Set(['type', 'name', 'score', 'probabilities', 'confidence']),
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

const isUnitNumber = (value: unknown): value is number => {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
};

const readUnit = (args: { path: string; value: unknown }): number => {
  if (!isUnitNumber(args.value)) {
    throw invalid(`${args.path} must be a number in 0–1.`);
  }
  return args.value;
};

/** Each entry of a `probabilities` list, its `value` read by `readValue`. */
const readDistribution = <T>(args: {
  path: string;
  probabilities: unknown;
  fields: ReadonlySet<string>;
  readEntry: (args: {
    path: string;
    entry: Record<string, unknown>;
    probability: number;
  }) => { key: string; read: T };
}): T[] => {
  const { path } = args;
  if (!Array.isArray(args.probabilities)) {
    throw invalid(`${path}.probabilities must be an array.`);
  }
  const seen = new Set<string>();
  return args.probabilities.map((entry, index) => {
    const at = `${path}.probabilities[${index}]`;
    if (!isPlainObject(entry)) throw invalid(`${at} must be an object.`);
    for (const field of Object.keys(entry)) {
      if (!args.fields.has(field)) {
        throw invalid(`${at}.${field} is not part of the answer contract.`);
      }
    }
    const probability = readUnit({
      path: `${at}.probability`,
      value: entry.probability,
    });
    const { key, read } = args.readEntry({ path: at, entry, probability });
    if (seen.has(key)) throw invalid(`${at}.value repeats an earlier entry.`);
    seen.add(key);
    return read;
  });
};

const readChoice = (args: {
  path: string;
  question: ChoiceQuestion;
  answer: Record<string, unknown>;
}): DecisionAnswer => {
  const { path, question, answer } = args;
  const values = new Set(
    question.choices.map((choice) => {
      return choice.value;
    })
  );
  const { choice } = answer;
  if (typeof choice !== 'string' || !values.has(choice)) {
    throw invalid(`${path}.choice must be one of the question's values.`);
  }
  const read: DecisionAnswer = { type: 'choice', name: question.name, choice };
  if (answer.probabilities !== undefined) {
    read.probabilities = readDistribution<ChoiceProbability>({
      path,
      probabilities: answer.probabilities,
      fields: new Set(['value', 'probability']),
      readEntry: ({ path: at, entry, probability }) => {
        if (typeof entry.value !== 'string' || !values.has(entry.value)) {
          throw invalid(`${at}.value names no value of the question.`);
        }
        return {
          key: entry.value,
          read: { value: entry.value, probability },
        };
      },
    });
  }
  if (answer.confidence !== undefined) {
    read.confidence = readUnit({
      path: `${path}.confidence`,
      value: answer.confidence,
    });
  }
  return read;
};

const isLevelIndex = (args: { value: unknown; levels: number }) => {
  return (
    typeof args.value === 'number' &&
    Number.isInteger(args.value) &&
    args.value >= 0 &&
    args.value < args.levels
  );
};

const readScore = (args: {
  path: string;
  question: ScoreQuestion;
  answer: Record<string, unknown>;
}): DecisionAnswer => {
  const { path, question, answer } = args;
  const top = question.levels.length - 1;
  const { score } = answer;
  if (
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > top
  ) {
    throw invalid(`${path}.score must be a number in 0–${top}.`);
  }
  const read: DecisionAnswer = { type: 'score', name: question.name, score };
  if (answer.probabilities !== undefined) {
    // `label` is accepted from engines that echo it, and replaced by the
    // decider's own.
    read.probabilities = readDistribution<LevelProbability>({
      path,
      probabilities: answer.probabilities,
      fields: new Set(['value', 'label', 'probability']),
      readEntry: ({ path: at, entry, probability }) => {
        if (!isLevelIndex({ value: entry.value, levels: top + 1 })) {
          throw invalid(`${at}.value must be a level index.`);
        }
        const value = Number(entry.value);
        return {
          key: String(value),
          read: { value, label: question.levels[value].label, probability },
        };
      },
    });
  }
  if (answer.confidence !== undefined) {
    read.confidence = readUnit({
      path: `${path}.confidence`,
      value: answer.confidence,
    });
  }
  return read;
};

const readAnswer = (args: {
  path: string;
  question: DeciderQuestion;
  answer: Record<string, unknown>;
}): DecisionAnswer => {
  const { path, question, answer } = args;
  for (const field of Object.keys(answer)) {
    if (!ANSWER_FIELDS[question.type].has(field)) {
      throw invalid(`${path}.${field} is not part of the answer contract.`);
    }
  }
  if (answer.type !== undefined && answer.type !== question.type) {
    throw invalid(`${path}.type must be '${question.type}'.`);
  }
  switch (question.type) {
    case 'predicate':
      return {
        type: 'predicate',
        name: question.name,
        probability: readUnit({
          path: `${path}.probability`,
          value: answer.probability,
        }),
      };
    case 'choice':
      return readChoice({ path, question, answer });
    case 'score':
      return readScore({ path, question, answer });
  }
};

/**
 * Reads a tool's answer to the question set, or throws naming why not. The
 * answers come back in question order, whatever order the tool sent.
 */
export const parseToolAnswers = (args: {
  questions: DeciderQuestions;
  raw: unknown;
}): DecisionAnswer[] => {
  const { answers } = envelopeOf(args.raw);
  if (!Array.isArray(answers)) {
    throw invalid('The tool answer carries no answers array.');
  }
  const byName = new Map<
    string,
    { path: string; answer: Record<string, unknown> }
  >();
  for (const [index, answer] of answers.entries()) {
    const path = `answers[${index}]`;
    if (!isPlainObject(answer)) throw invalid(`${path} must be an object.`);
    const { name } = answer;
    if (
      typeof name !== 'string' ||
      !args.questions.some((question) => {
        return question.name === name;
      })
    ) {
      throw invalid(`${path}.name names no question.`);
    }
    if (byName.has(name)) throw invalid(`${path} answers '${name}' twice.`);
    byName.set(name, { path, answer });
  }
  return args.questions.map((question) => {
    const entry = byName.get(question.name);
    if (!entry) throw invalid(`The answer to '${question.name}' is missing.`);
    return readAnswer({ ...entry, question });
  });
};

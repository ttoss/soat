import createDebug from 'debug';

import { DomainError } from '../errors';
import { egressGuardedFetch } from './egressFetch';

const log = createDebug('soat:jev');

/**
 * TypeSafe's System One endpoint. One POST carries the state and every
 * question; the model evaluates them in parallel and in isolation, so a
 * decider's whole question set costs one round trip.
 */
const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const SYSTEM_ONE_PATH = '/v1/systemone';

export const DEFAULT_JEV_MODEL = 'jev-latest';

export type ChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type ScoreAnswer = {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities?: Record<string, number>;
  confidence: number;
};

export type NoulAnswer = {
  type: 'noul';
  noul: number;
};

export type SystemOneAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type SystemOneResponse = {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const asNumber = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/** Every weight must be a number, or the distribution is not one. */
const parseProbabilities = (value: unknown): Record<string, number> | null => {
  if (!isRecord(value)) return null;
  const probabilities: Record<string, number> = {};
  for (const [key, weight] of Object.entries(value)) {
    const parsed = asNumber(weight);
    if (parsed === null) return null;
    probabilities[key] = parsed;
  }
  return probabilities;
};

const parseLegend = (value: unknown): Record<string, string> | null => {
  if (!isRecord(value)) return null;
  const legend: Record<string, string> = {};
  for (const [level, label] of Object.entries(value)) {
    if (typeof label !== 'string') return null;
    legend[level] = label;
  }
  return legend;
};

const parseChoice = (value: Record<string, unknown>): ChoiceAnswer | null => {
  const confidence = asNumber(value.confidence);
  const probabilities = parseProbabilities(value.probabilities);
  if (typeof value.choice !== 'string') return null;
  if (confidence === null || !probabilities) return null;
  return { type: 'choice', choice: value.choice, probabilities, confidence };
};

const parseScore = (value: Record<string, unknown>): ScoreAnswer | null => {
  const score = asNumber(value.score);
  const confidence = asNumber(value.confidence);
  const legend = parseLegend(value.legend);
  if (score === null || confidence === null || !legend) return null;

  const answer: ScoreAnswer = { type: 'score', score, legend, confidence };
  const probabilities = parseProbabilities(value.probabilities);
  if (probabilities) answer.probabilities = probabilities;
  return answer;
};

const parseNoul = (value: Record<string, unknown>): NoulAnswer | null => {
  const noul = asNumber(value.noul);
  return noul === null ? null : { type: 'noul', noul };
};

/**
 * The answer shapes, narrowed one field at a time.
 *
 * The response is external data, so nothing here trusts the `type` tag alone:
 * an answer that names a primitive but omits the value it promises is dropped
 * rather than carried into a stored decision, where a consumer branching on
 * `answers.x.choice` would read `undefined` as a decision.
 */
const parseAnswer = (value: unknown): SystemOneAnswer | null => {
  if (!isRecord(value)) return null;
  if (value.type === 'noul') return parseNoul(value);
  if (value.type === 'choice') return parseChoice(value);
  if (value.type === 'score') return parseScore(value);
  return null;
};

const parseResponse = (body: unknown): SystemOneResponse => {
  if (!isRecord(body) || !isRecord(body.answers)) {
    throw new DomainError(
      'AI_PROVIDER_ERROR',
      'The System One provider returned a body with no `answers` object.'
    );
  }

  const answers: Record<string, SystemOneAnswer> = {};
  for (const [id, raw] of Object.entries(body.answers)) {
    const answer = parseAnswer(raw);
    if (!answer) {
      throw new DomainError(
        'AI_PROVIDER_ERROR',
        `The System One provider returned an answer for \`${id}\` that carries no usable value.`
      );
    }
    answers[id] = answer;
  }

  const usage = isRecord(body.usage) ? body.usage : {};

  return {
    model: typeof body.model === 'string' ? body.model : DEFAULT_JEV_MODEL,
    answers,
    usage: {
      input_tokens: asNumber(usage.input_tokens) ?? 0,
      output_tokens: asNumber(usage.output_tokens) ?? 0,
    },
  };
};

/**
 * Evaluate every question against one state.
 *
 * `state` is passed through as given — a string or a JSON object — because the
 * questions address its parts by path, and reshaping it here would break every
 * instruction that names a key.
 */
export const askSystemOne = async (args: {
  state: unknown;
  questions: object;
  model: string;
  apiKey: string;
  baseUrl?: string;
}): Promise<SystemOneResponse> => {
  const url = `${(args.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}${SYSTEM_ONE_PATH}`;

  log('askSystemOne: model=%s url=%s', args.model, url);

  let response: Response;
  try {
    response = await egressGuardedFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state: args.state,
        model: args.model,
        questions: args.questions,
      }),
    });
  } catch (error) {
    throw new DomainError(
      'AI_PROVIDER_ERROR',
      `The System One provider could not be reached: ${
        error instanceof Error ? error.message : 'unknown error'
      }`
    );
  }

  if (!response.ok) {
    // The provider's own body goes to the log, never to the caller: the host
    // that wrote it is one the provider record named, as for model listing.
    const detail = await response.text().catch(() => {
      return '';
    });
    log('askSystemOne: provider returned %d: %s', response.status, detail);
    throw new DomainError(
      'AI_PROVIDER_ERROR',
      `The System One provider rejected the request with status ${response.status}.`
    );
  }

  const body: unknown = await response.json().catch(() => {
    return null;
  });

  return parseResponse(body);
};

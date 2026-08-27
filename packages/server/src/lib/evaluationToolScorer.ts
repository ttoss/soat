/**
 * The `tool` scorer's invocation half (the evaluations module doc — Custom
 * scorers): the eval names a project tool, the engine calls it once per item,
 * and the tool answers the same `{ score, passed }` shape every built-in
 * produces — so nothing downstream needs a notion of "custom".
 *
 * Split from `evaluationScorers.ts` to keep that module pure. The output parser
 * here is pure too and tested directly; the call and ref checks are covered
 * through REST.
 */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { ToolScorerVerdict } from './evaluationToolScorerContract';
import { isPlainObject } from './plainObject';
import { callTool } from './tools';

const log = createDebug('soat:evaluations');

// ── Output parsing ─────────────────────────────────────────────────────────

/** The first `{ … }` span in the text, parsed, or null when there is none. */
const firstJsonObject = (text: string): Record<string, unknown> | null => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** The tool's `score`, or a `VALIDATION_FAILED` naming why it is unusable. */
const requireToolScore = (score: unknown): number => {
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `The scorer tool's score is not a number: ${JSON.stringify(score)}`
    );
  }
  if (score < 0 || score > 1) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `The scorer tool's score ${score} is outside the 0–1 range.`
    );
  }
  return score;
};

/**
 * Parses `{ score, passed?, reasoning? }` out of a scorer tool's result.
 *
 * Lenient about the envelope, as `parseJudgeVerdict` is — an `http` target may
 * answer `text/plain` and an `mcp` result is text content, so a string is
 * scanned for its first `{ … }` span. Strict about the contract: `score` must
 * be a finite number in 0–1, and `passed`, when present, a real boolean, since
 * it decides the verdict and coercing `"false"` would be worse than refusing.
 *
 * Throws `VALIDATION_FAILED`, which the caller records as an **item-level
 * error** — a scorer that cannot answer must never land as a score of 0.
 */
export const parseToolScorerOutput = (raw: unknown): ToolScorerVerdict => {
  const parsed =
    typeof raw === 'string'
      ? firstJsonObject(raw)
      : isPlainObject(raw)
        ? raw
        : null;

  if (!parsed) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `The scorer tool did not answer with a JSON object: ${JSON.stringify(raw)?.slice(0, 200)}`
    );
  }

  if (parsed.passed !== undefined && typeof parsed.passed !== 'boolean') {
    throw new DomainError(
      'VALIDATION_FAILED',
      `The scorer tool's passed must be a boolean when present: ${JSON.stringify(parsed.passed)}`
    );
  }

  const { reasoning } = parsed;
  return {
    score: requireToolScore(parsed.score),
    ...(parsed.passed === undefined ? {} : { passed: parsed.passed }),
    ...(typeof reasoning === 'string' && reasoning !== '' ? { reasoning } : {}),
  };
};

// ── Reference validation ───────────────────────────────────────────────────

/**
 * Resolves every tool scorer's `tool_id` **within the eval's project** and
 * checks the tool is one an eval run can invoke.
 *
 * Shape validation (`validateScorers`) stays pure, so this DB half runs beside
 * it at the same three gates: eval create, eval update, and — authoritatively —
 * run start, since a tool can be deleted by then. A failure is a `400` naming
 * the scorer, never a mid-run surprise.
 *
 * `client` tools are refused for the reason ingestion refuses them as
 * converters: they pause for a calling client, and an eval run executes
 * server-side with none attached.
 */
export const validateToolScorerRefs = async (args: {
  scorers: unknown;
  projectId: number;
}): Promise<void> => {
  if (!Array.isArray(args.scorers)) return;

  for (const raw of args.scorers) {
    if (!isPlainObject(raw) || raw.type !== 'tool') continue;

    const name = String(raw.name);
    const toolId = String(raw.tool_id);
    log(
      'validateToolScorerRefs: projectId=%d scorer=%s toolId=%s',
      args.projectId,
      name,
      toolId
    );

    const tool = await db.Tool.findOne({
      where: { publicId: toolId, projectId: args.projectId },
      attributes: ['type'],
    });

    if (!tool) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `scorer '${name}': tool_id '${toolId}' does not reference a tool in this project.`
      );
    }
    if (tool.type === 'client') {
      throw new DomainError(
        'VALIDATION_FAILED',
        `scorer '${name}': client tools cannot be used as scorers; they are executed by the calling client, but an eval run scores server-side.`
      );
    }
    if ((tool.type === 'builtin' || tool.type === 'mcp') && !raw.action) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `scorer '${name}': action is required when the scorer tool type is soat or mcp.`
      );
    }
  }
};

// ── The call ───────────────────────────────────────────────────────────────

/**
 * Runs one tool scorer call and returns its parsed verdict.
 *
 * The input is the scorer's `preset_parameters` (fixed, caller-authored
 * configuration) with the item context spread **over** it — the context keys
 * are reserved at validation, and the spread order makes the engine's values
 * win even if a stored config predates that rule. The call is project-scoped
 * through the ordinary `callTool` path, so a scorer can never borrow another
 * project's tool.
 */
export const runToolScorerCall = async (args: {
  projectId: number;
  scorer: Record<string, unknown>;
  context: Record<string, unknown>;
}): Promise<ToolScorerVerdict> => {
  const toolId = String(args.scorer.tool_id);
  const presetParameters = isPlainObject(args.scorer.preset_parameters)
    ? args.scorer.preset_parameters
    : {};

  log(
    'runToolScorerCall: projectId=%d scorer=%s toolId=%s',
    args.projectId,
    args.scorer.name,
    toolId
  );

  const raw = await callTool({
    projectIds: [args.projectId],
    id: toolId,
    action:
      typeof args.scorer.action === 'string' ? args.scorer.action : undefined,
    input: { ...presetParameters, ...args.context },
  });

  return parseToolScorerOutput(raw);
};

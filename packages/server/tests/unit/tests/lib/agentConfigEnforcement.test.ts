import * as fs from 'node:fs';
import * as path from 'node:path';

import { AGENT_SCALAR_FIELDS } from 'src/lib/agents';

// Two agent config fields have shipped accepted-but-inert: the API took them,
// the version snapshot archived them, and nothing at runtime read them —
// `active_tool_ids` and `stop_conditions`. Both looked correct
// from every read surface, which is why neither was caught by the tests that
// existed. This pins the third from happening the same way.
//
// The contract is "reaches its enforcement point", not "reaches the model
// call": `stop_conditions` carries `max_chain_generations`, which is enforced
// where a continuation is *spawned* and deliberately never reaches `stopWhen`.
// So a field declares where it is enforced, and the declaration is checked
// against the source rather than trusted.

const LIB_DIR = path.resolve(__dirname, '../../../../src/lib');

/**
 * Source with comments removed, so the check below matches only code. A stale
 * doc comment naming a field must not keep this contract green after the code
 * that read the field is gone. String and template literals are kept — they
 * are live code here (`readType(entry) === 'has_tool_call'` is exactly how a
 * stop condition is matched) — which is also why the scanner tracks them: a
 * comment opener inside one is content, not a comment.
 */
type ScanMode = 'code' | 'line' | 'block' | "'" | '"' | '`';

/** One scanner step: the mode to continue in, characters consumed, output emitted. */
type ScanStep = { mode: ScanMode; consumed: number; emit: string };

const stepInCode = (source: string, i: number): ScanStep => {
  const pair = source.slice(i, i + 2);
  if (pair === '//') return { mode: 'line', consumed: 2, emit: '' };
  if (pair === '/*') return { mode: 'block', consumed: 2, emit: '' };

  const char = source[i];
  const mode: ScanMode =
    char === "'" || char === '"' || char === '`' ? char : 'code';
  return { mode, consumed: 1, emit: char };
};

const stepInLineComment = (source: string, i: number): ScanStep => {
  const char = source[i];
  return char === '\n'
    ? { mode: 'code', consumed: 1, emit: char }
    : { mode: 'line', consumed: 1, emit: '' };
};

const stepInBlockComment = (source: string, i: number): ScanStep => {
  const isClose = source.slice(i, i + 2) === '*/';
  return isClose
    ? { mode: 'code', consumed: 2, emit: '' }
    : { mode: 'block', consumed: 1, emit: '' };
};

/** Inside a string or template literal: copy verbatim, honor escapes. */
const stepInLiteral = (source: string, i: number, mode: ScanMode): ScanStep => {
  const char = source[i];
  if (char === '\\') {
    return { mode, consumed: 2, emit: source.slice(i, i + 2) };
  }
  return char === mode
    ? { mode: 'code', consumed: 1, emit: char }
    : { mode, consumed: 1, emit: char };
};

const nextScanStep = (source: string, i: number, mode: ScanMode): ScanStep => {
  if (mode === 'code') return stepInCode(source, i);
  if (mode === 'line') return stepInLineComment(source, i);
  if (mode === 'block') return stepInBlockComment(source, i);
  return stepInLiteral(source, i, mode);
};

const stripComments = (source: string): string => {
  let out = '';
  let i = 0;
  let mode: ScanMode = 'code';
  while (i < source.length) {
    const step = nextScanStep(source, i, mode);
    out += step.emit;
    i += step.consumed;
    mode = step.mode;
  }
  return out;
};

/**
 * Where a field is acted on. `modules` are `src/lib` filenames that must each
 * mention the field; a field enforced in several places lists all of them, so
 * dropping one is a failure rather than a silent narrowing.
 */
type Enforced = {
  modules: [string, ...string[]];
  enforces: string;
};

/**
 * A field that changes no runtime behavior. An explicit, reasoned entry rather
 * than an omission — the point of the test is that nobody adds a field without
 * deciding which of the two it is.
 */
type NotBehavioral = { notBehavioral: string };

type Declaration = Enforced | NotBehavioral;

// Tolerates a missing entry so an undeclared field is reported by the
// exhaustiveness test below, rather than crashing the suite before it runs.
const isEnforced = (
  declaration: Declaration | undefined
): declaration is Enforced => {
  return declaration !== undefined && 'modules' in declaration;
};

const ENFORCEMENT: Record<(typeof AGENT_SCALAR_FIELDS)[number], Declaration> = {
  name: {
    notBehavioral:
      'Identity, shown on read surfaces; nothing dispatches on it.',
  },
  instructions: {
    modules: ['agentGenerationContext.ts'],
    enforces: 'Becomes the system prompt on the outgoing request.',
  },
  model: {
    modules: ['agentModelResolution.ts'],
    enforces: 'Selects the completion model, overriding the provider default.',
  },
  maxSteps: {
    modules: ['agentStopConditions.ts'],
    enforces: 'Bounds the steps a turn may spend, across every pause it takes.',
  },
  toolChoice: {
    modules: ['agentGenerationContext.ts', 'agentStepRules.ts'],
    enforces:
      'Sent to the provider, and read by `forcesATool` for the write-time exit rule.',
  },
  stopConditions: {
    modules: ['agentStopConditions.ts', 'generationChain.ts'],
    enforces:
      'Turn-scoped `has_tool_call` reaches `stopWhen`; chain-scoped `max_chain_generations` bounds continuation spawning instead — the two points this test exists to keep distinct.',
  },
  activeToolIds: {
    modules: ['agentToolSelection.ts'],
    enforces: 'Narrows the tool surface the model is offered.',
  },
  stepRules: {
    modules: ['agentStepRules.ts'],
    enforces: 'Rewrites per-step request settings through `prepareStep`.',
  },
  boundaryPolicy: {
    modules: ['agentToolResolver.ts'],
    enforces: 'Decides which cross-project resources the agent may reach.',
  },
  temperature: {
    modules: ['agentNonStreamGeneration.ts', 'agentStreamGeneration.ts'],
    enforces: 'Sent to the provider on the generation call.',
  },
  knowledgeConfig: {
    modules: ['agentKnowledge.ts'],
    enforces: 'Drives retrieval and the knowledge tools attached to the turn.',
  },
  outputSchema: {
    modules: ['agentGenerationHelpers.ts'],
    enforces: 'Constrains the response to a structured output shape.',
  },
  promptCaching: {
    modules: ['agentGenerationContext.ts'],
    enforces:
      'Marks the cache breakpoint on the assembled history, at the end of the static prefix.',
  },
  maxContextMessages: {
    modules: ['conversationGeneration.ts'],
    enforces: 'Truncates the conversation history sent with the turn.',
  },
  singleSessionPerActor: {
    modules: ['sessions.ts'],
    enforces: 'Refuses a second concurrent session for the same end user.',
  },
  guardrailIds: {
    modules: ['agentToolSurface.ts'],
    enforces: 'Attaches the guardrails evaluated before a tool call executes.',
  },
  traceContentMode: {
    modules: ['traceContentPolicy.ts'],
    enforces: 'Decides whether turn content is persisted at all.',
  },
  onApprovalExpiry: {
    modules: ['agentApprovalExpiry.ts'],
    enforces:
      'Decides whether a lapsed approval terminates the turn or resumes it.',
  },
};

describe('agent config field enforcement contract', () => {
  test('every accepted config field declares where it is enforced', () => {
    // The guard that makes this test hard to bypass: a field added to the write
    // path with no entry here fails, so the decision cannot be skipped.
    expect(Object.keys(ENFORCEMENT).sort()).toEqual(
      [...AGENT_SCALAR_FIELDS].sort()
    );
  });

  const enforcedFields = AGENT_SCALAR_FIELDS.filter((field) => {
    return isEnforced(ENFORCEMENT[field]);
  });

  test('some field is enforced somewhere other than the model call', () => {
    // Keeps the contract from being re-narrowed to "reaches the provider
    // request", which would flag `max_chain_generations` as a defect when it is
    // enforced exactly as designed.
    const declaration = ENFORCEMENT.stopConditions;
    expect(isEnforced(declaration) && declaration.modules).toContain(
      'generationChain.ts'
    );
  });

  test.each(enforcedFields)('%s is read by every module it names', (field) => {
    const declaration = ENFORCEMENT[field];
    if (!isEnforced(declaration)) throw new Error('expected an enforced field');

    for (const moduleName of declaration.modules) {
      const modulePath = path.join(LIB_DIR, moduleName);
      expect(fs.existsSync(modulePath)).toBe(true);
      // A claim checked against the source, with comments stripped: a field
      // dropped from the module that enforces it fails here rather than going
      // quietly inert behind a doc comment that still names it.
      expect(stripComments(fs.readFileSync(modulePath, 'utf-8'))).toContain(
        field
      );
    }
  });

  test('a non-behavioral field states why it is exempt', () => {
    for (const field of AGENT_SCALAR_FIELDS) {
      const declaration = ENFORCEMENT[field];
      if (declaration === undefined || isEnforced(declaration)) continue;
      expect(declaration.notBehavioral.length).toBeGreaterThan(0);
    }
  });
});

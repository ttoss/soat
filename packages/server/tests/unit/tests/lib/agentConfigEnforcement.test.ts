import * as fs from 'node:fs';
import * as path from 'node:path';

import { AGENT_SCALAR_FIELDS } from 'src/lib/agents';

// Two agent config fields have shipped accepted-but-inert: the API took them,
// the version snapshot archived them, and nothing at runtime read them —
// `active_tool_ids` (#811) and `stop_conditions` (#1167). Both looked correct
// from every read surface, which is why neither was caught by the tests that
// existed. This pins the third from happening the same way.
//
// The contract is "reaches its enforcement point", not "reaches the model
// call": `stop_conditions` carries `maxChainGenerations`, which is enforced
// where a continuation is *spawned* and deliberately never reaches `stopWhen`.
// So a field declares where it is enforced, and the declaration is checked
// against the source rather than trusted.

const LIB_DIR = path.resolve(__dirname, '../../../../src/lib');

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
      'Turn-scoped `hasToolCall` reaches `stopWhen`; chain-scoped `maxChainGenerations` bounds continuation spawning instead — the two points this test exists to keep distinct.',
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
    // request", which would flag `maxChainGenerations` as a defect when it is
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
      // A claim checked against the source: a field dropped from the module
      // that enforces it fails here rather than going quietly inert.
      expect(fs.readFileSync(modulePath, 'utf-8')).toContain(field);
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

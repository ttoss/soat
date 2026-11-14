import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');
const modelsDir = path.join(repoRoot, 'packages/postgresdb/src/models');
const RULE = 'lib/writerRule.ts';

/** Source with comments dropped, so prose naming a symbol is not a hit. */
const code = (file) => {
  return fs
    .readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      return !/^\s*\/\//.test(line);
    })
    .join('\n');
};

const serverFiles = fs
  .readdirSync(srcDir, { recursive: true })
  .filter((entry) => {
    return entry.endsWith('.ts');
  })
  .sort();

const sourceOf = (entry) => {
  return code(path.join(srcDir, entry));
};

/** The body of `export const <name> = {` up to its closing `}`. */
const registryBody = (file, name) => {
  const source = code(path.join(srcDir, file));
  const start = source.indexOf(`export const ${name} = {`);
  return source.slice(start, source.indexOf('\n}', start));
};

/** Each `WRITER_RULE_CARRIERS` entry with the models whose rows it writes. */
const carriers = () => {
  const policyBody = registryBody('lib/policyCarriers.ts', 'POLICY_CARRIERS');
  const policyModels = (name) => {
    const start = policyBody.indexOf(`\n  ${name}: `);
    const entry = policyBody.slice(start, policyBody.indexOf('\n  }', start));
    const listed = /models: \[([^\]]*)\]/.exec(entry);
    const single = /model: '(\w+)'/.exec(entry);
    return listed
      ? [...listed[1].matchAll(/'(\w+)'/g)].map((m) => {
          return m[1];
        })
      : [single[1]];
  };
  return [
    ...registryBody(RULE, 'WRITER_RULE_CARRIERS').matchAll(
      /^ {2}(\w+): \{([^}]*)\}/gm
    ),
  ].map(([, name, entry]) => {
    const policies = /policies: '(\w+)'/.exec(entry);
    const models = /models: \[([^\]]*)\]/.exec(entry);
    return {
      name,
      models: policies
        ? policyModels(policies[1])
        : [...models[1].matchAll(/'(\w+)'/g)].map((m) => {
            return m[1];
          }),
    };
  });
};

/**
 * Model → why a row naming a policy, an agent, a tool or a target is not
 * written by someone it later acts for: it records work, or it is checked
 * where its writer is checked.
 */
const NOT_A_CARRIER = {
  ActivityEntry: 'records what ran',
  Actor: 'an end user; it starts nothing',
  ApprovalItem: 'records a proposed call; the approval runs it',
  ConversationMessage: 'records which agent answered',
  ExceptionItem: 'records a failure',
  Generation: 'records a run',
  GenerationChain: 'records a run',
  GuardrailEvaluation: 'records an evaluation',
  OrchestrationRun: 'records a run of an orchestration',
  OrchestrationVersion:
    "an orchestration's archived graph, written back through its update",
  PlaybookExport: "records an export a case's execution started",
  Session: 'binds a conversation to its agent; the turn is checked as its caller',
  TaskTransition: 'records a transition',
  Trace: 'records a run',
  UsageEvent: 'records metered use',
};

const START_COLUMN =
  /\bdeclare (policyIds|targetId|agentId|toolId|contextToolId|orchestrationId)\b/;

/**
 * Whoever creates or edits a resource that acts later holds what it will do,
 * answered once by `assertWriterHolds` (`lib/writerRule.ts`) for every
 * carrier `WRITER_RULE_CARRIERS` names.
 */
describe('writer rule', () => {
  test('every model naming what it acts on or under is classified', () => {
    const registered = carriers().flatMap((carrier) => {
      return carrier.models;
    });
    const naming = fs
      .readdirSync(modelsDir)
      .filter((file) => {
        return START_COLUMN.test(code(path.join(modelsDir, file)));
      })
      .map((file) => {
        return file.replace(/\.ts$/, '');
      });
    assert.ok(naming.length > 0);
    for (const model of naming) {
      assert.ok(
        registered.includes(model) ||
          Object.hasOwn(NOT_A_CARRIER, model),
        `${model} names a policy, agent, tool or target: add it to WRITER_RULE_CARRIERS (${RULE}) and write it through assertWriterHolds`
      );
    }
    for (const model of [...registered, ...Object.keys(NOT_A_CARRIER)]) {
      assert.ok(
        fs.existsSync(path.join(modelsDir, `${model}.ts`)),
        `a writer-rule list names a model that does not exist: ${model}`
      );
    }
  });

  test('every carrier is written through assertWriterHolds', () => {
    const sites = serverFiles
      .filter((entry) => {
        return entry !== RULE;
      })
      .map(sourceOf)
      .join('\n');
    assert.ok(carriers().length > 0);
    for (const { name } of carriers()) {
      assert.match(
        sites,
        new RegExp(`assertWriterHolds\\(\\{\\s*carrier: '${name}'`),
        `no write of a ${name} goes through assertWriterHolds`
      );
    }
  });

  test('only the writer rule attaches policies', () => {
    const calling = serverFiles.filter((entry) => {
      return /\bassertWriterMayAttach\(/.test(sourceOf(entry));
    });
    assert.deepEqual(calling, [RULE]);
  });

  // Each reads policy ids for its own question; the writer rule's is the
  // only one a write asks.
  test('one reading of "these ids name policies"', () => {
    const OTHER_READINGS = {
      'lib/attachedPolicies.ts':
        'at run time, where a policy that no longer resolves allows nothing',
      'lib/iamTokens.ts':
        'a token bound, refused without saying which id failed',
    };
    const reading = serverFiles.filter((entry) => {
      return /db\.Policy\.findAll\(\{[^}]*\bpublicId:/.test(sourceOf(entry));
    });
    assert.deepEqual(reading, [...Object.keys(OTHER_READINGS), RULE].sort());
  });
});

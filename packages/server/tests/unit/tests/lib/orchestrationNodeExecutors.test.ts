import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { eventBus, type SoatEvent } from 'src/lib/eventBus';
import { parseDuration } from 'src/lib/orchestrationDuration';
import { executeEmitEventNode } from 'src/lib/orchestrationEmitEventNode';
import {
  applyStateMapping,
  executeToolNode,
} from 'src/lib/orchestrationNodeExecutors';

/**
 * Two pure tables with an input space no run could cover case by case: how a
 * `state_mapping` writes into run state (prefixing, dotted paths, the
 * intermediates it creates, merges or replaces) and which duration strings a
 * `delay` / `poll` interval accepts. Then the one interleaving no entry point
 * orders deterministically: a node executing after its run's project was
 * deleted. Each executor's behavior inside a run — its artifact, its parking,
 * its failure — is asserted through the entry point in
 * `rest/orchestrationNodeExecution.test.ts`.
 */

// ── applyStateMapping ────────────────────────────────────────────────────────

describe('applyStateMapping', () => {
  test('does nothing when stateMapping is undefined', () => {
    const state: Record<string, unknown> = {};
    applyStateMapping(undefined, { result: 42 }, state);
    expect(state).toEqual({});
  });

  test('writes a {"var": "output.<key>"} expression result to state under the mapped path', () => {
    const state: Record<string, unknown> = {};
    applyStateMapping(
      { 'state.output': { var: 'output.result' } },
      { result: 42 },
      state
    );
    expect(state['output']).toBe(42);
  });

  test('a state path without the state. prefix is normalized to one', () => {
    const state: Record<string, unknown> = {};
    applyStateMapping(
      { output: { var: 'output.result' } },
      { result: 42 },
      state
    );
    expect(state['output']).toBe(42);
  });

  test('a dotted path builds a nested object', () => {
    const state: Record<string, unknown> = {};
    applyStateMapping(
      { 'state.proposed.action_id': { var: 'output.result' } },
      { result: 'act_1' },
      state
    );
    expect(state['proposed']).toEqual({ action_id: 'act_1' });
  });

  test('a deep multi-level dotted path creates every intermediate object', () => {
    const state: Record<string, unknown> = {};
    applyStateMapping(
      { 'state.a.b.c': { var: 'output.result' } },
      { result: 7 },
      state
    );
    expect(state).toEqual({ a: { b: { c: 7 } } });
  });

  test('a dotted write merges into an existing intermediate object', () => {
    const state: Record<string, unknown> = { proposed: { existing: 1 } };
    applyStateMapping(
      { 'state.proposed.action_id': { var: 'output.result' } },
      { result: 'act_2' },
      state
    );
    expect(state['proposed']).toEqual({ existing: 1, action_id: 'act_2' });
  });

  test('a dotted write overwrites a non-object intermediate value', () => {
    const state: Record<string, unknown> = { proposed: 'scalar' };
    applyStateMapping(
      { 'state.proposed.action_id': { var: 'output.result' } },
      { result: 'act_3' },
      state
    );
    expect(state['proposed']).toEqual({ action_id: 'act_3' });
  });

  test('a literal (non-logic) value is written as-is, matching input_mapping semantics', () => {
    const state: Record<string, unknown> = {};
    applyStateMapping({ 'state.label': 'literal text' }, {}, state);
    expect(state['label']).toBe('literal text');
  });

  test('an expression can read the current state alongside the artifact', () => {
    const state: Record<string, unknown> = { count: 1 };
    applyStateMapping(
      {
        'state.count': {
          '+': [{ var: 'state.count' }, { var: 'output.delta' }],
        },
      },
      { delta: 4 },
      state
    );
    expect(state['count']).toBe(5);
  });

  test('a dotted write replaces an array intermediate with an object', () => {
    const state: Record<string, unknown> = { proposed: [1, 2] };
    applyStateMapping(
      { 'state.proposed.action_id': { var: 'output.result' } },
      { result: 'act_4' },
      state
    );
    expect(state['proposed']).toEqual({ action_id: 'act_4' });
  });
});

// ── parseDuration ──────────────────────────────────────────────────────────

describe('parseDuration', () => {
  test('parses the friendly suffix form', () => {
    expect(parseDuration('5s')).toBe(5000);
    expect(parseDuration('30s')).toBe(30000);
    expect(parseDuration('5m')).toBe(300000);
    expect(parseDuration('2h')).toBe(7200000);
    expect(parseDuration('1d')).toBe(86400000);
    expect(parseDuration('500ms')).toBe(500);
  });

  test('parses ISO 8601 durations', () => {
    expect(parseDuration('PT5S')).toBe(5000);
    expect(parseDuration('PT1M30S')).toBe(90000);
    expect(parseDuration('P1DT2H')).toBe(93600000);
  });

  test('returns 0 for unparseable input', () => {
    expect(parseDuration('INVALID')).toBe(0);
    expect(parseDuration('')).toBe(0);
  });
});

// ── a project deleted mid-run ─────────────────────────────────────────────

/**
 * Deleting a project takes its runs with it, but a drive already in memory
 * finishes the node it is executing, against a project row that is gone.
 */
describe('a node executing after its project was deleted', () => {
  let goneProjectId: number;

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'deleted-mid-run' });
    goneProjectId = project.id as number;
    await project.destroy();
  });

  test('an emit_event node completes, emitting under an empty project id', async () => {
    const events: SoatEvent[] = [];
    const capture = (event: SoatEvent) => {
      events.push(event);
    };
    eventBus.on('soat:event', capture);
    try {
      const result = await executeEmitEventNode({
        node: { id: 'n1', type: 'emit_event', eventType: 'custom.happened' },
        state: {},
        projectId: goneProjectId,
        runPublicId: 'orch_run_gone',
      });

      expect(result).toEqual({
        kind: 'artifact',
        artifact: { emitted: true, eventType: 'custom.happened' },
      });
      const emitted = events.find((event) => {
        return event.type === 'custom.happened';
      });
      expect(emitted?.projectPublicId).toBe('');
      expect(emitted?.resourceId).toBe('orch_run_gone');
    } finally {
      eventBus.off('soat:event', capture);
    }
  });

  test('a tool node fails: its tool no longer resolves in the project', async () => {
    await expect(
      executeToolNode({
        node: { id: 'n1', type: 'tool', toolId: 'tool_deletedmidrun' },
        state: {},
        projectId: goneProjectId,
      })
    ).rejects.toBeInstanceOf(DomainError);
  });
});

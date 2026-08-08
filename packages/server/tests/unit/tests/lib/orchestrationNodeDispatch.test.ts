import { DomainError } from 'src/errors';
import { executeNodeById } from 'src/lib/orchestrationNodeDispatch';
import { REQUIRED_NODE_FIELDS } from 'src/lib/orchestrationNodeFields';
import type { OrchestrationNode } from 'src/lib/orchestrations';

/**
 * One table, one test. `REQUIRED_NODE_FIELDS` declares which field each node
 * type cannot execute without; the executors used to restate that rule with
 * eleven hand-written throws spread over four files, which is why nothing
 * noticed that they disagreed on both message and meaning (#914).
 *
 * Driving the cases from the table means a new node type is covered the moment
 * its entry is added, and a type whose executor forgets the guard fails here
 * rather than at a customer's first run.
 */
const nodeOf = (type: OrchestrationNode['type']): OrchestrationNode => {
  return { id: 'n1', type };
};

describe('executeNodeById', () => {
  const entries = Object.entries(REQUIRED_NODE_FIELDS) as Array<
    [OrchestrationNode['type'], keyof OrchestrationNode]
  >;

  test('the table covers every node type that requires a field', () => {
    expect(entries.length).toBe(11);
  });

  test.each(entries)(
    'a %s node missing %s fails the node instead of dispatching',
    async (type, field) => {
      const node = nodeOf(type);
      await expect(
        executeNodeById({
          nodeId: node.id,
          nodes: [node],
          state: {},
          projectIds: [1],
          traceId: null,
        })
      ).rejects.toThrow(
        new DomainError(
          'ORCHESTRATION_NODE_FAILED',
          `${type} node '${node.id}' missing ${String(field)}.`
        )
      );
    }
  );

  test('an unknown node type fails the node', async () => {
    // A stored definition can name a type the dispatcher does not implement;
    // the cast is how a test reaches that branch from typed code.
    const node = nodeOf('nope' as OrchestrationNode['type']);
    await expect(
      executeNodeById({
        nodeId: node.id,
        nodes: [node],
        state: {},
        projectIds: [1],
        traceId: null,
      })
    ).rejects.toThrow(/Unknown node type 'nope'/);
  });

  test('a node id absent from the definition fails the node', async () => {
    await expect(
      executeNodeById({
        nodeId: 'missing',
        nodes: [nodeOf('human')],
        state: {},
        projectIds: [1],
        traceId: null,
      })
    ).rejects.toThrow(/not found in orchestration definition/);
  });
});

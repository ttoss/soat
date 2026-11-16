import {
  carriedActionsOfRegisteredWrite,
  declaredActionsOf,
} from 'src/lib/formationResourceTypeWriter';

const writer = {
  resourceType: 'channel',
  actions: {
    create: 'channels:CreateChannel',
    update: 'channels:UpdateChannel',
    delete: 'channels:DeleteChannel',
  },
  carries: [
    {
      property: 'default.agent_id',
      action: 'agents:CreateAgentGeneration',
      resourceType: 'agent',
    },
    { property: 'tools[]', action: 'tools:CallTool', resourceType: 'tool' },
  ],
};

describe('carriedActionsOfRegisteredWrite', () => {
  test('a create takes its action on the whole type and every carried id', () => {
    expect(
      carriedActionsOfRegisteredWrite({
        writer,
        request: 'create',
        properties: {
          default: { agent_id: 'agt_1' },
          tools: ['tol_1', 'tol_2'],
        },
      })
    ).toEqual([
      {
        action: 'channels:CreateChannel',
        resourceType: 'channel',
        resourceId: '*',
      },
      {
        action: 'agents:CreateAgentGeneration',
        resourceType: 'agent',
        resourceId: 'agt_1',
      },
      { action: 'tools:CallTool', resourceType: 'tool', resourceId: 'tol_1' },
      { action: 'tools:CallTool', resourceType: 'tool', resourceId: 'tol_2' },
    ]);
  });

  test('an update and a delete name the resource; absent properties carry nothing', () => {
    expect(
      carriedActionsOfRegisteredWrite({
        writer,
        request: 'delete',
        physicalResourceId: 'chn_1',
      })
    ).toEqual([
      {
        action: 'channels:DeleteChannel',
        resourceType: 'channel',
        resourceId: 'chn_1',
      },
    ]);
  });

  test('a carried value that is not an id fails closed', () => {
    expect(() => {
      return carriedActionsOfRegisteredWrite({
        writer,
        request: 'update',
        physicalResourceId: 'chn_1',
        properties: { tools: [{ id: 'tol_1' }] },
      });
    }).toThrow(/`tools\[\]` must name a tool by id/);
  });
});

describe('a property carrying actions keyed by its value', () => {
  const keyed = {
    ...writer,
    carries: [
      {
        property: 'events[]',
        byValue: new Map([
          ['*', [{ action: 'tasks:GetTask', resourceType: 'task' }]],
          [
            'task.created',
            [
              { action: 'tasks:GetTask', resourceType: 'task' },
              { action: 'agents:GetAgent', resourceType: 'agent' },
            ],
          ],
          ['ping', []],
        ]),
      },
    ],
  };

  test('each matched value takes its actions on the whole type', () => {
    expect(
      carriedActionsOfRegisteredWrite({
        writer: keyed,
        request: 'create',
        properties: { events: ['task.created', 'ping'] },
      })
    ).toEqual([
      {
        action: 'channels:CreateChannel',
        resourceType: 'channel',
        resourceId: '*',
      },
      { action: 'tasks:GetTask', resourceType: 'task', resourceId: '*' },
      { action: 'agents:GetAgent', resourceType: 'agent', resourceId: '*' },
    ]);
  });

  test('a value with no key fails closed', () => {
    expect(() => {
      return carriedActionsOfRegisteredWrite({
        writer: keyed,
        request: 'create',
        properties: { events: ['*', 'constructor'] },
      });
    }).toThrow(/`events\[\]` does not accept 'constructor'/);
  });

  test('a value that is not a string fails closed', () => {
    expect(() => {
      return carriedActionsOfRegisteredWrite({
        writer: keyed,
        request: 'create',
        properties: { events: [1] },
      });
    }).toThrow(/`events\[\]` does not accept '1'/);
  });

  test('declares every keyed action', () => {
    expect(declaredActionsOf(keyed)).toEqual(
      expect.arrayContaining([
        { action: 'tasks:GetTask', resourceType: 'task' },
        { action: 'agents:GetAgent', resourceType: 'agent' },
      ])
    );
  });
});

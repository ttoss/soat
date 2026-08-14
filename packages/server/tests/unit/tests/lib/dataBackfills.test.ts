/**
 * The boot-time data backfills (`src/lib/dataBackfills.ts`).
 *
 * Two kinds of coverage, for the two reasons `tests.md`'s keep-list allows a
 * direct `lib/` test:
 *
 * - The normalizers are pure functions over a large input space (arbitrary
 *   stored JSON), and no entry point reaches them — nothing in the API asks for
 *   a row to be renormalized.
 * - The runners have no entry point at all: they fire from a `beforeBulkSync`
 *   hook at boot. They are exercised against the real database, seeding the
 *   pre-upgrade schema with raw DDL the way a long-lived deployment would carry
 *   it.
 */
import { db } from '../../../../src/db';
import { isPlainObject } from '../../../../src/lib/plainObject';
import {
  backfillAgentStepRules,
  backfillAgentToolBindings,
  backfillToolExecute,
  normalizeStoredExecute,
  normalizeStoredStepRules,
  normalizeStoredToolChoice,
} from '../../../../src/lib/dataBackfills';
import { setupProjectWithUsers } from '../../fixtures/bootstrap';

describe('normalizeStoredToolChoice', () => {
  test('renames a camelCase toolName to the wire spelling', () => {
    expect(
      normalizeStoredToolChoice({ type: 'tool', toolName: 'my_tool' })
    ).toEqual({
      changed: true,
      value: { type: 'tool', tool_name: 'my_tool' },
    });
  });

  test('leaves an already-snake_case choice untouched', () => {
    const value = { type: 'tool', tool_name: 'my_tool' };
    expect(normalizeStoredToolChoice(value)).toEqual({ changed: false, value });
  });

  test('keeps tool_name when a row carries both spellings', () => {
    expect(
      normalizeStoredToolChoice({
        type: 'tool',
        tool_name: 'wins',
        toolName: 'loses',
      })
    ).toEqual({
      changed: true,
      value: { type: 'tool', tool_name: 'wins' },
    });
  });

  test.each([['auto'], ['required'], ['none']])(
    'passes the string form %s through',
    (value) => {
      expect(normalizeStoredToolChoice(value)).toEqual({
        changed: false,
        value,
      });
    }
  );

  test.each([[null], [undefined], [42], [['a']], [{ type: 'other' }]])(
    'leaves a value it does not understand alone: %p',
    (value) => {
      expect(normalizeStoredToolChoice(value)).toEqual({
        changed: false,
        value,
      });
    }
  );
});

describe('normalizeStoredStepRules', () => {
  test('renames both camelCase keys and the nested tool name', () => {
    expect(
      normalizeStoredStepRules([
        {
          step: 1,
          toolChoice: { type: 'tool', toolName: 'a' },
          activeToolIds: ['tool_1'],
        },
      ])
    ).toEqual({
      changed: true,
      value: [
        {
          step: 1,
          tool_choice: { type: 'tool', tool_name: 'a' },
          active_tool_ids: ['tool_1'],
        },
      ],
    });
  });

  test('preserves rule order and leaves already-normalized rules alone', () => {
    const rules = [
      { step: 1, tool_choice: 'required' },
      { step: 2, active_tool_ids: ['tool_2'] },
    ];
    expect(normalizeStoredStepRules(rules)).toEqual({
      changed: false,
      value: rules,
    });
  });

  test('the wire spelling wins when a rule carries both', () => {
    expect(
      normalizeStoredStepRules([
        { step: 1, tool_choice: 'required', toolChoice: 'none' },
      ])
    ).toEqual({
      changed: true,
      value: [{ step: 1, tool_choice: 'required' }],
    });
  });

  test('normalizes only the rules that need it, in a mixed array', () => {
    const result = normalizeStoredStepRules([
      { step: 1, tool_choice: 'auto' },
      { step: 2, activeToolIds: ['tool_9'] },
    ]);
    expect(result.changed).toBe(true);
    expect(result.value).toEqual([
      { step: 1, tool_choice: 'auto' },
      { step: 2, active_tool_ids: ['tool_9'] },
    ]);
  });

  test.each([[null], [undefined], ['nope'], [{ step: 1 }]])(
    'leaves a non-array value alone: %p',
    (value) => {
      expect(normalizeStoredStepRules(value)).toEqual({
        changed: false,
        value,
      });
    }
  );
});

describe('normalizeStoredExecute', () => {
  test('parses an execute persisted as a JSON string', () => {
    expect(
      normalizeStoredExecute('{"url":"https://example.com/a","method":"POST"}')
    ).toEqual({
      changed: true,
      value: { url: 'https://example.com/a', method: 'POST' },
    });
  });

  test('renames a camelCase bodyMode to the wire spelling', () => {
    expect(
      normalizeStoredExecute({
        url: 'https://example.com/a',
        bodyMode: 'multipart',
      })
    ).toEqual({
      changed: true,
      value: { url: 'https://example.com/a', body_mode: 'multipart' },
    });
  });

  test('handles a JSON string that also carries bodyMode', () => {
    expect(
      normalizeStoredExecute(
        '{"url":"https://example.com/a","bodyMode":"multipart"}'
      )
    ).toEqual({
      changed: true,
      value: { url: 'https://example.com/a', body_mode: 'multipart' },
    });
  });

  test('keeps body_mode when a row carries both spellings', () => {
    expect(
      normalizeStoredExecute({
        url: 'https://example.com/a',
        body_mode: 'json',
        bodyMode: 'multipart',
      })
    ).toEqual({
      changed: true,
      value: { url: 'https://example.com/a', body_mode: 'json' },
    });
  });

  test('leaves an already-normalized execute untouched', () => {
    const value = { url: 'https://example.com/a', body_mode: 'multipart' };
    expect(normalizeStoredExecute(value)).toEqual({ changed: false, value });
  });

  test('leaves a string that is not JSON alone rather than dropping it', () => {
    expect(normalizeStoredExecute('not json at all')).toEqual({
      changed: false,
      value: 'not json at all',
    });
  });

  test('leaves a JSON string that parses to a non-object alone', () => {
    expect(normalizeStoredExecute('[1,2]')).toEqual({
      changed: false,
      value: '[1,2]',
    });
  });

  test.each([[null], [undefined], [7]])(
    'leaves a value it does not understand alone: %p',
    (value) => {
      expect(normalizeStoredExecute(value)).toEqual({ changed: false, value });
    }
  );
});

// ── Runners, against the real database ────────────────────────────────────

describe('backfill runners (real DB)', () => {
  let projectDbId: number;
  let aiProviderDbId: number;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'backfill',
      policyActions: ['agents:CreateAgent'],
      createNoPermUser: false,
    });
    const project = await db.Project.findOne({
      where: { publicId: setup.projectId },
    });
    projectDbId = project!.id as number;

    const provider = await db.AiProvider.create({
      projectId: projectDbId,
      name: 'backfill-provider',
      provider: 'openai',
      apiKey: 'sk-test',
      defaultModel: 'gpt-4o',
    });
    aiProviderDbId = provider.id as number;
  });

  describe('backfillAgentToolBindings', () => {
    // A long-lived deployment still carries the pre-`toolBindings` columns; a
    // freshly-synced test database does not, since the model stopped declaring
    // them. Recreate them so the backfill sees what it exists to handle.
    const addLegacyColumns = async () => {
      await db.sequelize.query(
        'ALTER TABLE agents ADD COLUMN IF NOT EXISTS tool_ids jsonb, ADD COLUMN IF NOT EXISTS tools jsonb'
      );
    };
    const dropLegacyColumns = async () => {
      await db.sequelize.query(
        'ALTER TABLE agents DROP COLUMN IF EXISTS tool_ids, DROP COLUMN IF EXISTS tools'
      );
    };

    const seedLegacyAgent = async (args: {
      name: string;
      toolIds: unknown;
      tools: unknown;
      toolBindings?: unknown;
    }): Promise<string> => {
      const agent = await db.Agent.create({
        projectId: projectDbId,
        aiProviderId: aiProviderDbId,
        name: args.name,
      });
      await db.sequelize.query(
        'UPDATE agents SET tool_ids = :toolIds, tools = :tools, tool_bindings = :bindings WHERE id = :id',
        {
          replacements: {
            id: agent.id,
            toolIds: args.toolIds === null ? null : JSON.stringify(args.toolIds),
            tools: args.tools === null ? null : JSON.stringify(args.tools),
            bindings:
              args.toolBindings === undefined
                ? null
                : JSON.stringify(args.toolBindings),
          },
        }
      );
      return agent.publicId;
    };

    const readBindings = async (publicId: string): Promise<unknown> => {
      const [rows] = await db.sequelize.query(
        'SELECT tool_bindings FROM agents WHERE public_id = :publicId',
        { replacements: { publicId } }
      );
      const row = rows[0];
      return isPlainObject(row) ? row.tool_bindings : undefined;
    };

    afterEach(dropLegacyColumns);

    test('no-ops when the legacy columns are already gone', async () => {
      await dropLegacyColumns();
      await expect(
        backfillAgentToolBindings({ sequelize: db.sequelize })
      ).resolves.toBe(0);
    });

    test('derives references first, then inline definitions', async () => {
      await addLegacyColumns();
      const publicId = await seedLegacyAgent({
        name: 'legacy-both',
        toolIds: ['tool_a', 'tool_b'],
        tools: [{ name: 'inline-one', type: 'http' }],
      });

      expect(await backfillAgentToolBindings({ sequelize: db.sequelize })).toBe(
        1
      );
      expect(await readBindings(publicId)).toEqual([
        { toolId: 'tool_a' },
        { toolId: 'tool_b' },
        { tool: { name: 'inline-one', type: 'http' } },
      ]);
    });

    test('never overwrites a row that already has bindings', async () => {
      await addLegacyColumns();
      const publicId = await seedLegacyAgent({
        name: 'legacy-already-migrated',
        toolIds: ['tool_stale'],
        tools: null,
        toolBindings: [{ toolId: 'tool_current' }],
      });

      expect(await backfillAgentToolBindings({ sequelize: db.sequelize })).toBe(
        0
      );
      expect(await readBindings(publicId)).toEqual([
        { toolId: 'tool_current' },
      ]);
    });

    test('leaves an empty legacy pair as null, not an empty array', async () => {
      await addLegacyColumns();
      // `readAgentToolBindings` returned null for this row, and the response
      // maps null to `tool_bindings: null`. Writing `[]` would flip that.
      const publicId = await seedLegacyAgent({
        name: 'legacy-empty',
        toolIds: [],
        tools: [],
      });

      await backfillAgentToolBindings({ sequelize: db.sequelize });
      expect(await readBindings(publicId)).toBeNull();
    });

    test('is idempotent — a second run changes nothing', async () => {
      await addLegacyColumns();
      const publicId = await seedLegacyAgent({
        name: 'legacy-idempotent',
        toolIds: ['tool_a'],
        tools: null,
      });

      expect(await backfillAgentToolBindings({ sequelize: db.sequelize })).toBe(
        1
      );
      const first = await readBindings(publicId);
      expect(await backfillAgentToolBindings({ sequelize: db.sequelize })).toBe(
        0
      );
      expect(await readBindings(publicId)).toEqual(first);
    });

    test('survives a malformed legacy value instead of failing the boot', async () => {
      await addLegacyColumns();
      const publicId = await seedLegacyAgent({
        name: 'legacy-malformed',
        toolIds: 'not-an-array',
        tools: null,
      });

      await expect(
        backfillAgentToolBindings({ sequelize: db.sequelize })
      ).resolves.toBe(0);
      expect(await readBindings(publicId)).toBeNull();
    });
  });

  describe('backfillAgentStepRules', () => {
    test('normalizes camelCase step_rules and tool_choice, leaving others alone', async () => {
      const stale = await db.Agent.create({
        projectId: projectDbId,
        aiProviderId: aiProviderDbId,
        name: 'stale-rules-agent',
        toolChoice: { type: 'tool', toolName: 'agent_level' },
        stepRules: [
          { step: 1, toolChoice: { type: 'tool', toolName: 'step_one' } },
          { step: 2, activeToolIds: ['tool_z'] },
        ],
      });
      const fresh = await db.Agent.create({
        projectId: projectDbId,
        aiProviderId: aiProviderDbId,
        name: 'fresh-rules-agent',
        stepRules: [{ step: 1, tool_choice: 'required' }],
      });

      expect(
        await backfillAgentStepRules({ sequelize: db.sequelize })
      ).toBeGreaterThanOrEqual(1);

      await stale.reload();
      expect(stale.toolChoice).toEqual({
        type: 'tool',
        tool_name: 'agent_level',
      });
      expect(stale.stepRules).toEqual([
        { step: 1, tool_choice: { type: 'tool', tool_name: 'step_one' } },
        { step: 2, active_tool_ids: ['tool_z'] },
      ]);

      await fresh.reload();
      expect(fresh.stepRules).toEqual([{ step: 1, tool_choice: 'required' }]);
    });

    test('is idempotent — a second run reports nothing left to change', async () => {
      await backfillAgentStepRules({ sequelize: db.sequelize });
      expect(await backfillAgentStepRules({ sequelize: db.sequelize })).toBe(0);
    });
  });

  describe('backfillToolExecute', () => {
    test('normalizes a string execute and a camelCase bodyMode', async () => {
      const asString = await db.Tool.create({
        projectId: projectDbId,
        type: 'http',
        name: 'string-execute-tool',
      });
      await db.sequelize.query(
        'UPDATE tools SET execute = :execute WHERE id = :id',
        {
          replacements: {
            id: asString.id,
            execute: JSON.stringify(
              '{"url":"https://example.com/s","bodyMode":"multipart"}'
            ),
          },
        }
      );

      const camel = await db.Tool.create({
        projectId: projectDbId,
        type: 'http',
        name: 'camel-body-mode-tool',
        execute: { url: 'https://example.com/c', bodyMode: 'multipart' },
      });

      expect(
        await backfillToolExecute({ sequelize: db.sequelize })
      ).toBeGreaterThanOrEqual(2);

      await asString.reload();
      expect(asString.execute).toEqual({
        url: 'https://example.com/s',
        body_mode: 'multipart',
      });
      await camel.reload();
      expect(camel.execute).toEqual({
        url: 'https://example.com/c',
        body_mode: 'multipart',
      });
    });

    test("normalizes an inline binding's execute on an agent", async () => {
      const agent = await db.Agent.create({
        projectId: projectDbId,
        aiProviderId: aiProviderDbId,
        name: 'inline-execute-agent',
        toolBindings: [
          { toolId: 'tool_ref' },
          {
            tool: {
              name: 'inline-multipart',
              type: 'http',
              execute: { url: 'https://example.com/i', bodyMode: 'multipart' },
            },
          },
        ],
      });

      await backfillToolExecute({ sequelize: db.sequelize });

      await agent.reload();
      expect(agent.toolBindings).toEqual([
        { toolId: 'tool_ref' },
        {
          tool: {
            name: 'inline-multipart',
            type: 'http',
            execute: { url: 'https://example.com/i', body_mode: 'multipart' },
          },
        },
      ]);
    });

    test('is idempotent — a second run reports nothing left to change', async () => {
      await backfillToolExecute({ sequelize: db.sequelize });
      expect(await backfillToolExecute({ sequelize: db.sequelize })).toBe(0);
    });
  });
});

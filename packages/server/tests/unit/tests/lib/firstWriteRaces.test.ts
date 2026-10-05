import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';

import { db } from 'src/db';
import { findOrCreateChain } from 'src/lib/generationChains';
import { findOrCreateTrace } from 'src/lib/generationTrace';
import { saveTrace } from 'src/lib/traces';

/**
 * Two writers creating the same row at once: two hops of one chain both finding
 * no chain row, or a trace save racing the generation record that creates its
 * trace. The unique index decides the race and the loser re-reads the winner's
 * row.
 *
 * A `lib/` test (tests.md keep-list): the interleaving is a race no entry point
 * can drive deterministically. Here it is forced on the real database — the
 * winner's insert is held open in a transaction until the loser's insert is
 * blocked behind it, then committed.
 */
describe('first-write races', () => {
  let projectId: number;
  let projectPublicId: string;
  let agentId: number;
  let agentPublicId: string;

  /** Resolves once another session is blocked waiting on a row lock. */
  const lockWaiterAppears = async (): Promise<void> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const [rows] = await db.sequelize.query(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()"
      );
      const [row] = rows as Array<{ waiting: number }>;
      if (row.waiting > 0) return;
      await new Promise((resolve) => {
        return setTimeout(resolve, 10);
      });
    }
    throw new Error('no session ever blocked on the held insert');
  };

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'First Write Races' });
    projectId = project.id as number;
    projectPublicId = project.publicId;
    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'First Write Races Provider',
      provider: 'ollama',
      defaultModel: 'stub-model',
    });
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'First Write Races Agent',
    });
    agentId = agent.id as number;
    agentPublicId = agent.publicId;
  });

  test('a chain created concurrently is joined, not duplicated', async () => {
    const rootGenerationId = generatePublicId(PUBLIC_ID_PREFIXES.generation);
    const winnerId = generatePublicId(PUBLIC_ID_PREFIXES.generationChain);
    const held = await db.sequelize.transaction();
    await db.GenerationChain.create(
      {
        publicId: winnerId,
        projectId,
        agentId: agentPublicId,
        rootGenerationId,
        status: 'active',
        generationCount: 2,
      },
      { transaction: held }
    );

    const loser = findOrCreateChain({
      projectId,
      agentId: agentPublicId,
      rootGenerationId,
      memberCount: 2,
    });
    await lockWaiterAppears();
    await held.commit();

    expect(await loser).toBe(winnerId);
    expect(
      await db.GenerationChain.count({ where: { rootGenerationId } })
    ).toBe(1);
  });

  test('a trace created concurrently is updated, not duplicated', async () => {
    const traceId = generatePublicId(PUBLIC_ID_PREFIXES.trace);
    const held = await db.sequelize.transaction();
    await findOrCreateTrace({
      traceId,
      projectId,
      agentDbId: agentId,
      transaction: held,
    });

    const save = saveTrace({
      traceId,
      projectId,
      projectPublicId,
      agentId: agentPublicId,
      generationId: generatePublicId(PUBLIC_ID_PREFIXES.generation),
      steps: [{ type: 'text', text: 'done' }],
    });
    await lockWaiterAppears();
    await held.commit();
    await save;

    const rows = await db.Trace.findAll({ where: { publicId: traceId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].stepCount).toBe(1);
    expect(rows[0].fileId).not.toBeNull();
  });
});

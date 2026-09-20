import { db } from 'src/db';
import { SYSTEM_ROOT } from 'src/lib/filePaths';
import {
  backfillSystemPaths,
  countUnmigratedSystemPaths,
} from 'src/lib/systemPathBackfill';

/**
 * Rows written before `/.system/` existed stay outside it — and so stay in
 * every unfiltered read — until they are moved.
 */
describe('backfillSystemPaths', () => {
  let projectId: number;

  const legacyFile = async (path: string | null) => {
    return db.File.create({
      projectId,
      path,
      filename: 'document.txt',
      contentType: 'text/plain',
      size: 1,
      storageType: 'local',
      storagePath: '/tmp/legacy-object',
    });
  };

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'System Path Backfill' });
    projectId = project.id as number;
  });

  test('moves a conversation message document that carried no path', async () => {
    const conversation = await db.Conversation.create({
      projectId,
      status: 'open',
    });
    const file = await legacyFile(null);
    const document = await db.Document.create({ fileId: file.id });
    await db.ConversationMessage.create({
      conversationId: conversation.id,
      documentId: document.id,
      role: 'user',
      position: 0,
    });

    expect((await countUnmigratedSystemPaths()).messages).toBeGreaterThan(0);

    await backfillSystemPaths();

    await file.reload();
    expect(file.path).toBe(
      `${SYSTEM_ROOT}/conversations/${conversation.publicId}/${document.publicId}.txt`
    );
  });

  test('moves a trace object out of the caller namespace', async () => {
    const agent = await db.Agent.create({
      projectId,
      name: 'backfill agent',
      model: 'test-model',
    });
    const file = await legacyFile('/traces/trc_legacy_one.json');
    await db.Trace.create({
      publicId: 'trc_legacy_one',
      projectId,
      agentId: agent.id,
      fileId: file.id,
      stepCount: 1,
    });

    await backfillSystemPaths();

    await file.reload();
    expect(file.path).toBe(`${SYSTEM_ROOT}/traces/trc_legacy_one.json`);
  });

  test('is idempotent — a second pass moves nothing', async () => {
    const second = await backfillSystemPaths();

    expect(second.messages).toBe(0);
    expect(second.traces).toBe(0);
    expect(await countUnmigratedSystemPaths()).toEqual({
      messages: 0,
      traces: 0,
    });
  });

  test('leaves a trace in place when a caller file already holds the key', async () => {
    const agent = await db.Agent.create({
      projectId,
      name: 'backfill clash agent',
      model: 'test-model',
    });
    await legacyFile(`${SYSTEM_ROOT}/traces/trc_legacy_clash.json`);
    const traceFile = await legacyFile('/traces/trc_legacy_clash.json');
    await db.Trace.create({
      publicId: 'trc_legacy_clash',
      projectId,
      agentId: agent.id,
      fileId: traceFile.id,
      stepCount: 1,
    });

    const result = await backfillSystemPaths();

    expect(result.conflicts).toContain(
      `${SYSTEM_ROOT}/traces/trc_legacy_clash.json`
    );
    await traceFile.reload();
    expect(traceFile.path).toBe('/traces/trc_legacy_clash.json');
  });
});

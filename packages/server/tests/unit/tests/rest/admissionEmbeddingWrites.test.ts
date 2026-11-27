import { db } from 'src/db';
import {
  askEmbeddingWrite,
  askOfClaimedConversion,
  generationPrincipal,
} from 'src/lib/embeddingAdmission';
import { drainEvalQueueOnce } from 'src/lib/evaluationWorker';
import { EMBEDDING_USAGE_SOURCE } from 'src/lib/usageEmbeddingRecording';

import {
  type AdmissionService,
  REFUSAL,
  startAdmissionService,
} from '../../fixtures/admissionService';
import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { testGrant } from '../../fixtures/bootstrap';

/**
 * A write that embeds what it stores asks admission once, before anything is
 * written or embedded; a refusal raises instead of storing it unembedded.
 */
const EMBEDDINGS = 'embeddings:CreateEmbeddings';

let service: AdmissionService;
let turn: AgentToolTurn;
let projectDbId: number;

const embeddingMeters = (): Promise<number> => {
  return db.UsageEvent.count({
    where: { projectId: projectDbId, source: EMBEDDING_USAGE_SOURCE },
  });
};

const documentsInProject = (): Promise<number> => {
  return db.Document.count({
    include: [
      { model: db.File, as: 'file', where: { projectId: projectDbId } },
    ],
  });
};

const expectRefused = (res: { status: number; body: { error?: unknown } }) => {
  expect(res.status).toBe(409);
  expect(res.body.error).toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
};

beforeAll(async () => {
  process.env.EVAL_WORKER_DISABLED = 'true';
  service = await startAdmissionService();
  turn = await startAgentToolTurn({ prefix: 'admissionembed' });
  const project = await db.Project.findOne({
    where: { publicId: turn.projectId },
  });
  projectDbId = project!.id as number;
});

beforeEach(() => {
  service.declare({ actions: [EMBEDDINGS] });
});

afterEach(() => {
  service.undeclare();
});

afterAll(async () => {
  delete process.env.EVAL_WORKER_DISABLED;
  await turn.close();
  await service.close();
});

describe('admission — embedding writes', () => {
  test('a document asks once for all its chunks', async () => {
    const res = await turn.api().post('/api/v1/documents').send({
      project_id: turn.projectId,
      content: 'one two three four five six seven eight nine ten',
      chunk_strategy: 'size',
      chunk_size: 10,
      chunk_overlap: 0,
    });

    expect(res.status).toBe(201);
    const doc = await db.Document.findOne({
      where: { publicId: res.body.id },
    });
    const chunks = await db.DocumentChunk.count({
      where: { documentId: doc!.id as number },
    });
    expect(chunks).toBeGreaterThan(1);
    expect(service.asked).toHaveLength(1);
    expect(service.asked[0].body).toMatchObject({
      action: EMBEDDINGS,
      project_id: turn.projectId,
      body: null,
    });
  });

  test('a refused document is not stored and embeds nothing', async () => {
    service.reply = REFUSAL;
    const [documents, meters] = [
      await documentsInProject(),
      await embeddingMeters(),
    ];

    const res = await turn
      .api()
      .post('/api/v1/documents')
      .send({ project_id: turn.projectId, content: 'refused' });

    expectRefused(res);
    expect(await documentsInProject()).toBe(documents);
    expect(await embeddingMeters()).toBe(meters);
  });

  test('a refused ingest is not stored and embeds nothing', async () => {
    const file = await turn
      .api()
      .post('/api/v1/files/upload/base64')
      .send({
        project_id: turn.projectId,
        filename: turn.unique('ingest') + '.txt',
        content_type: 'text/plain',
        content: Buffer.from('one two three').toString('base64'),
      });
    expect(file.status).toBe(201);
    service.reply = REFUSAL;
    const [documents, meters] = [
      await documentsInProject(),
      await embeddingMeters(),
    ];

    const res = await turn
      .api()
      .post('/api/v1/documents/ingest?wait=true')
      .send({ file_id: file.body.id, project_id: turn.projectId });

    expectRefused(res);
    expect(await documentsInProject()).toBe(documents);
    expect(await embeddingMeters()).toBe(meters);
  });

  test('a refused memory write stores no content and embeds nothing', async () => {
    const store = await turn
      .api()
      .post('/api/v1/memory-stores')
      .send({ project_id: turn.projectId, name: turn.unique('store') });
    expect(store.status).toBe(201);
    service.reply = REFUSAL;
    const meters = await embeddingMeters();

    const res = await turn
      .api()
      .post('/api/v1/memories')
      .send({ memory_store_id: store.body.id, content: 'a refused fact' });

    expectRefused(res);
    const storeRow = await db.MemoryStore.findOne({
      where: { publicId: store.body.id },
    });
    expect(
      await db.MemoryContent.count({
        where: { memoryStoreId: storeRow!.id as number },
      })
    ).toBe(0);
    expect(await embeddingMeters()).toBe(meters);
  });

  test('a refused backlog embed leaves retrieval off and embeds nothing', async () => {
    const conversation = await turn
      .api()
      .post('/api/v1/conversations')
      .send({ project_id: turn.projectId, retrieval: 'none' });
    expect(conversation.status).toBe(201);
    const message = await turn
      .api()
      .post(`/api/v1/conversations/${conversation.body.id}/messages`)
      .send({ message: 'an earlier turn', role: 'user' });
    expect(message.status).toBe(201);
    service.reply = REFUSAL;
    const meters = await embeddingMeters();

    const res = await turn
      .api()
      .patch(`/api/v1/conversations/${conversation.body.id}`)
      .send({ retrieval: 'embed' });

    expectRefused(res);
    const read = await turn
      .api()
      .get(`/api/v1/conversations/${conversation.body.id}`);
    expect(read.body.retrieval).toBe('none');
    expect(await embeddingMeters()).toBe(meters);
  });

  test('a refused eval embedding scorer fails the run and embeds nothing', async () => {
    const agentId = await turn.createAgent({});
    const dataset = await turn
      .api()
      .post('/api/v1/datasets')
      .send({ project_id: turn.projectId, name: turn.unique('set') });
    await turn
      .api()
      .post(`/api/v1/datasets/${dataset.body.id}/items`)
      .send({
        input: [{ role: 'user', content: 'hello' }],
        expected_output: 'hello',
      });
    const evaluation = await turn
      .api()
      .post('/api/v1/evals')
      .send({
        policy_ids: await testGrant({ token: turn.adminToken }),
        project_id: turn.projectId,
        name: turn.unique('eval'),
        agent_id: agentId,
        dataset_id: dataset.body.id,
        scorers: [
          {
            type: 'embedding_similarity',
            name: 'similarity',
            pass_threshold: 0.5,
          },
        ],
      });
    expect(evaluation.status).toBe(201);
    const run = await turn
      .api()
      .post(`/api/v1/evals/${evaluation.body.id}/runs`)
      .send({ wait: false });
    expect(run.status).toBe(201);
    service.reply = REFUSAL;
    const meters = await embeddingMeters();

    await drainEvalQueueOnce();

    const stopped = (
      await turn
        .api()
        .get(`/api/v1/evals/${evaluation.body.id}/runs/${run.body.id}`)
    ).body;
    expect(stopped.status).toBe('failed');
    expect(stopped.error.code).toBe('PLAN_LIMIT_REACHED');
    expect(await embeddingMeters()).toBe(meters);
  });
});

describe('admission — embedding writes without a request', () => {
  test("a generation's stored authority is the principal its write asks as", async () => {
    const agentId = await turn.createAgent({});
    const generation = await turn.generate({ agentId, calls: [] });
    const principal = await generationPrincipal({
      generationId: generation.id,
    });
    expect(principal).not.toBeNull();
    const before = service.asked.length;

    const ask = await askEmbeddingWrite({
      projectId: projectDbId,
      principal,
      work: 'The memory rule',
    });

    expect(ask.projectId).toBe(projectDbId);
    expect(service.asked).toHaveLength(before + 1);
    expect(service.asked[before].body).toMatchObject({
      action: EMBEDDINGS,
      project_id: turn.projectId,
    });
  });

  test('work with no stored generation holds no principal', async () => {
    expect(await generationPrincipal({ generationId: null })).toBeNull();
    expect(await generationPrincipal({ generationId: undefined })).toBeNull();
    expect(
      await generationPrincipal({ generationId: 'gen_does_not_exist' })
    ).toBeNull();
  });

  test('a write holding no principal is refused while declared, unasked', async () => {
    await expect(
      askEmbeddingWrite({
        projectId: projectDbId,
        principal: null,
        work: 'The memory rule',
      })
    ).rejects.toMatchObject({ code: 'WORK_AUTHORITY_MISSING' });
    expect(service.asked).toHaveLength(0);
  });

  test('an undeclared write is not asked, principal or not', async () => {
    service.undeclare();

    const ask = await askEmbeddingWrite({
      projectId: projectDbId,
      principal: null,
      work: 'The memory rule',
    });

    expect(ask.projectId).toBe(projectDbId);
    expect(service.asked).toHaveLength(0);
  });

  test('a write billed to no known project asks under none', async () => {
    const agentId = await turn.createAgent({});
    const generation = await turn.generate({ agentId, calls: [] });
    const principal = await generationPrincipal({
      generationId: generation.id,
    });
    const before = service.asked.length;

    await askEmbeddingWrite({ projectId: null, principal, work: 'The call' });
    await askEmbeddingWrite({ projectId: -1, principal, work: 'The call' });

    expect(
      service.asked.slice(before).map((asked) => {
        return asked.body.project_id;
      })
    ).toEqual([null, null]);
  });

  test("a converter's callback reuses its ingest's ask, asking nothing", () => {
    const ask = askOfClaimedConversion({
      projectId: projectDbId,
      claimed: true,
    });

    expect(ask.projectId).toBe(projectDbId);
    expect(service.asked).toHaveLength(0);
  });
});

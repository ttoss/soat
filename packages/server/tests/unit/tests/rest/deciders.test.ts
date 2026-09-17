import { createServer, type Server } from 'node:http';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const DECIDER_ACTIONS = [
  'deciders:CreateDecider',
  'deciders:ListDeciders',
  'deciders:GetDecider',
  'deciders:UpdateDecider',
  'deciders:DeleteDecider',
  'deciders:EvaluateDecider',
  'deciders:ListDecisions',
  'deciders:GetDecision',
];

const PROVIDER_ACTIONS = [
  'ai-providers:CreateAiProvider',
  'secrets:CreateSecret',
  'api-keys:CreateApiKey',
  'policies:CreatePolicy',
];

// The canonical support-triage question set from the TypeSafe quickstart: one
// question of each type, so a single evaluation exercises all three answer
// shapes.
const triageQuestions = {
  department: {
    type: 'choice',
    instructions: 'Which team should handle this',
    criteria: {
      billing: 'Payment or subscription issues',
      technical: 'Bugs or integration problems',
      sales: 'Pricing or account questions',
    },
  },
  frustration: {
    type: 'score',
    instructions: 'How frustrated the customer appears',
    criteria: [
      'Calm, just stating facts',
      'Frustrated but civil',
      'Very angry, strong language',
    ],
  },
  is_urgent: {
    type: 'noul',
    instructions: 'The message conveys urgency or time-sensitivity',
  },
};

const systemOneResponse = {
  model: 'jev-latest',
  answers: {
    department: {
      type: 'choice',
      choice: 'technical',
      probabilities: { billing: 0.159, technical: 0.84, sales: 0.001 },
      confidence: 0.596,
    },
    frustration: {
      type: 'score',
      score: 1.035,
      legend: {
        '0': 'Calm, just stating facts',
        '1': 'Frustrated but civil',
        '2': 'Very angry, strong language',
      },
      probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 },
      confidence: 0.842,
    },
    is_urgent: { type: 'noul', noul: 0.999 },
  },
  usage: { input_tokens: 312, output_tokens: 48 },
};

type StubReply = { status: number; body: string };

describe('Deciders', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let noPermToken: string;
  let aiProviderId: string;
  let deciderId: string;

  // A real System One stub on loopback (already in the suite's egress
  // allowlist), so `lib/jev.ts` — the request it builds and the response it
  // narrows — runs for real rather than behind a spy.
  let stub: Server;
  let stubReply: StubReply;
  let lastRequestBody: Record<string, unknown>;

  const startStub = async (): Promise<string> => {
    stub = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += String(chunk);
      });
      req.on('end', () => {
        lastRequestBody = JSON.parse(raw || '{}');
        res.writeHead(stubReply.status, {
          'Content-Type': 'application/json',
        });
        res.end(stubReply.body);
      });
    });

    await new Promise<void>((resolve) => {
      stub.listen(0, '127.0.0.1', resolve);
    });

    const address = stub.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'deciders',
      policyActions: [...DECIDER_ACTIONS, ...PROVIDER_ACTIONS],
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    noPermToken = setup.noPermToken as string;

    const baseUrl = await startStub();

    // The provider must link a secret: `evaluateDecider` refuses to call the
    // System One endpoint without an API key to send.
    const secretRes = await authenticatedTestClient(userToken)
      .post('/api/v1/secrets')
      .send({
        project_id: projectId,
        name: 'TypeSafe Key',
        value: 'ts-test-key',
      });

    const providerRes = await authenticatedTestClient(userToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'TypeSafe',
        provider: 'typesafe',
        default_model: 'jev-latest',
        base_url: baseUrl,
        secret_id: secretRes.body.id,
      });
    aiProviderId = providerRes.body.id;

    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/deciders')
      .send({
        project_id: projectId,
        name: 'Support Triage',
        ai_provider_id: aiProviderId,
        questions: triageQuestions,
      });
    deciderId = res.body.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      stub.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    stubReply = { status: 200, body: JSON.stringify(systemOneResponse) };
  });

  describe('POST /api/v1/deciders', () => {
    test('creates a decider with a dcd_ id and version 1', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'Created Decider',
          ai_provider_id: aiProviderId,
          questions: { is_bug: { type: 'noul', instructions: 'Is a bug?' } },
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^dcd_/);
      expect(res.body.name).toBe('Created Decider');
      expect(res.body.project_id).toBe(projectId);
      expect(res.body.version).toBe(1);
      expect(res.body.model).toBe('jev-latest');
      expect(res.body.questions.is_bug.type).toBe('noul');
    });

    test('401 without a token', async () => {
      const res = await testClient
        .post('/api/v1/deciders')
        .send({ project_id: projectId, name: 'x' });
      expect(res.status).toBe(401);
    });

    test('403 for a caller without the action', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'Denied',
          ai_provider_id: aiProviderId,
          questions: triageQuestions,
        });
      expect(res.status).toBe(403);
    });

    test('400 when questions is empty', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'No Questions',
          ai_provider_id: aiProviderId,
          questions: {},
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('400 when a question is not an object', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'Bad Question',
          ai_provider_id: aiProviderId,
          questions: { q: 'urgent?' },
        });
      expect(res.status).toBe(400);
    });

    test('400 when instructions is missing', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'No Instructions',
          ai_provider_id: aiProviderId,
          questions: { q: { type: 'noul' } },
        });
      expect(res.status).toBe(400);
    });

    test('400 when a choice question has fewer than two options', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'One Option',
          ai_provider_id: aiProviderId,
          questions: {
            team: {
              type: 'choice',
              instructions: 'Which team',
              criteria: { billing: 'Payments' },
            },
          },
        });
      expect(res.status).toBe(400);
    });

    test('400 when a choice option has no description', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'Blank Option',
          ai_provider_id: aiProviderId,
          questions: {
            team: {
              type: 'choice',
              instructions: 'Which team',
              criteria: { billing: 'Payments', sales: '' },
            },
          },
        });
      expect(res.status).toBe(400);
    });

    test('400 when a choice question has no criteria object', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'No Criteria',
          ai_provider_id: aiProviderId,
          questions: {
            team: { type: 'choice', instructions: 'Which team' },
          },
        });
      expect(res.status).toBe(400);
    });

    test('400 when a score question has fewer than two levels', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'One Level',
          ai_provider_id: aiProviderId,
          questions: {
            heat: {
              type: 'score',
              instructions: 'How hot',
              criteria: ['Cold'],
            },
          },
        });
      expect(res.status).toBe(400);
    });

    test('400 when a score level is not a string', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'Bad Level',
          ai_provider_id: aiProviderId,
          questions: {
            heat: {
              type: 'score',
              instructions: 'How hot',
              criteria: ['Cold', 42],
            },
          },
        });
      expect(res.status).toBe(400);
    });

    test('400 when a score question has no criteria array', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'No Levels',
          ai_provider_id: aiProviderId,
          questions: {
            heat: { type: 'score', instructions: 'How hot' },
          },
        });
      expect(res.status).toBe(400);
    });

    test("400 when a noul's criteria is not an object", async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'Bad Noul Criteria',
          ai_provider_id: aiProviderId,
          questions: {
            urgent: {
              type: 'noul',
              instructions: 'Is it urgent?',
              criteria: ['yes', 'no'],
            },
          },
        });
      expect(res.status).toBe(400);
    });

    test("accepts a noul's optional criteria object", async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'Noul Criteria',
          ai_provider_id: aiProviderId,
          questions: {
            urgent: {
              type: 'noul',
              instructions: 'Is it urgent?',
              criteria: { yes: 'Needs action today', no: 'Can wait' },
            },
          },
        });
      expect(res.status).toBe(201);
    });

    test('400 when a question type is not a primitive', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'Bad Type',
          ai_provider_id: aiProviderId,
          questions: {
            q: { type: 'ranking', instructions: 'Rank these' },
          },
        });
      expect(res.status).toBe(400);
    });

    test('400 when ai_provider_id is missing', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'No Provider',
          questions: triageQuestions,
        });
      expect(res.status).toBe(400);
    });

    test('400 when name is not a string', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 42,
          ai_provider_id: aiProviderId,
          questions: triageQuestions,
        });
      expect(res.status).toBe(400);
    });

    // A project-scoped key supplies its own project, so the body may omit
    // `project_id` entirely.
    test('a project-scoped API key creates without project_id', async () => {
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [{ effect: 'Allow', action: DECIDER_ACTIONS }],
          },
        });
      const keyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'Decider Scoped Key',
          project_id: projectId,
          policy_ids: [policyRes.body.id],
        });

      const res = await authenticatedTestClient(keyRes.body.key as string)
        .post('/api/v1/deciders')
        .send({
          name: 'Scoped Key Decider',
          ai_provider_id: aiProviderId,
          questions: { a: { type: 'noul', instructions: 'A?' } },
        });

      expect(res.status).toBe(201);
      expect(res.body.project_id).toBe(projectId);
    });

    test('400 when name is missing', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          questions: triageQuestions,
        });
      expect(res.status).toBe(400);
    });

    test('400 when the provider does not exist', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'Missing Provider',
          ai_provider_id: 'aip_doesnotexist',
          questions: triageQuestions,
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AI_PROVIDER_NOT_FOUND');
    });

    test('400 when the provider is not a typesafe provider', async () => {
      const openaiRes = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'OpenAI',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'Wrong Provider',
          ai_provider_id: openaiRes.body.id,
          questions: triageQuestions,
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /api/v1/deciders', () => {
    test('lists deciders in the project', async () => {
      const res = await authenticatedTestClient(userToken)
        .get(`/api/v1/deciders?project_id=${projectId}`)
        .send();

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(
        res.body.data.some((d: { id: string }) => {
          return d.id === deciderId;
        })
      ).toBe(true);
    });

    test('401 without a token', async () => {
      const res = await testClient.get('/api/v1/deciders').send();
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/deciders/{decider_id}', () => {
    test('returns the decider with its question set', async () => {
      const res = await authenticatedTestClient(userToken)
        .get(`/api/v1/deciders/${deciderId}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(deciderId);
      // JSONB does not preserve key order, so the set is what matters.
      expect(Object.keys(res.body.questions).sort()).toEqual([
        'department',
        'frustration',
        'is_urgent',
      ]);
    });

    test('404 for an unknown decider', async () => {
      const res = await authenticatedTestClient(userToken)
        .get('/api/v1/deciders/dcd_doesnotexist')
        .send();
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/deciders/{decider_id}', () => {
    test('bumps the version when the question set changes', async () => {
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'Versioned',
          ai_provider_id: aiProviderId,
          questions: { a: { type: 'noul', instructions: 'A?' } },
        });

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${created.body.id}`)
        .send({
          questions: { a: { type: 'noul', instructions: 'A changed?' } },
        });

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(2);
    });

    test('does not bump the version when only the name changes', async () => {
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'Rename Me',
          ai_provider_id: aiProviderId,
          questions: { a: { type: 'noul', instructions: 'A?' } },
        });

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${created.body.id}`)
        .send({ name: 'Renamed' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Renamed');
      expect(res.body.version).toBe(1);
    });

    test('repoints the decider at another typesafe provider', async () => {
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'Repoint Me',
          ai_provider_id: aiProviderId,
          questions: { a: { type: 'noul', instructions: 'A?' } },
        });

      const other = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'TypeSafe Two',
          provider: 'typesafe',
          default_model: 'jev-latest',
        });

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${created.body.id}`)
        .send({ ai_provider_id: other.body.id, model: 'jev-pinned' });

      expect(res.status).toBe(200);
      expect(res.body.ai_provider_id).toBe(other.body.id);
      expect(res.body.model).toBe('jev-pinned');
      expect(res.body.version).toBe(1);
    });

    test('400 for an invalid question set', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${deciderId}`)
        .send({ questions: { q: { type: 'ranking', instructions: 'Rank' } } });
      expect(res.status).toBe(400);
    });

    test('403 for a caller without the action', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/deciders/${deciderId}`)
        .send({ name: 'Nope' });
      expect([403, 404]).toContain(res.status);
    });
  });

  describe('POST /api/v1/deciders/{decider_id}/evaluate', () => {
    test('returns typed answers and stores a decision', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state: 'The API returns 500 on every request. We are down.' });

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^dec_/);
      expect(res.body.decider_id).toBe(deciderId);
      expect(res.body.decider_version).toBe(1);
      expect(res.body.model).toBe('jev-latest');
      expect(res.body.answers.department.choice).toBe('technical');
      expect(res.body.answers.department.probabilities.technical).toBeCloseTo(
        0.84
      );
      expect(res.body.answers.frustration.score).toBeCloseTo(1.035);
      expect(res.body.answers.frustration.legend['1']).toBe(
        'Frustrated but civil'
      );
      expect(res.body.answers.is_urgent.noul).toBeCloseTo(0.999);
      expect(res.body.usage.input_tokens).toBe(312);

      // The decider's question set is what gets asked — the caller supplies
      // only the state, so a decision is always reproducible from its decider.
      expect(lastRequestBody.questions).toEqual(triageQuestions);
      expect(lastRequestBody.model).toBe('jev-latest');
    });

    // The docs promise a structured state whose parts the questions address by
    // path, so the spec's `oneOf` has to survive `strictFields`.
    test('accepts a JSON object as the state', async () => {
      const state = {
        ticket: { subject: 'Duplicate charge' },
        refund_policy: 'Duplicate charges are eligible for a refund.',
      };

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state });

      expect(res.status).toBe(201);
      expect(lastRequestBody.state).toEqual(state);
    });

    test('the stored decision is readable afterwards', async () => {
      const evaluated = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state: 'Another ticket' });

      const res = await authenticatedTestClient(userToken)
        .get(`/api/v1/decisions/${evaluated.body.id}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(evaluated.body.id);
      expect(res.body.decider_version).toBe(1);
      expect(res.body.answers.department.choice).toBe('technical');
    });

    test('502 when the provider rejects the request', async () => {
      stubReply = { status: 429, body: '{"error":"rate limited"}' };

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state: 'x' });

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('AI_PROVIDER_ERROR');
      // The provider's own body is logged, never forwarded.
      expect(res.body.error.message).not.toContain('rate limited');
    });

    test('502 when the body carries no answers object', async () => {
      stubReply = { status: 200, body: '{"model":"jev-latest"}' };

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state: 'x' });

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('AI_PROVIDER_ERROR');
    });

    test('502 when the body is not JSON', async () => {
      stubReply = { status: 200, body: 'not json at all' };

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state: 'x' });

      expect(res.status).toBe(502);
    });

    test('502 when an answer names a type it carries no value for', async () => {
      stubReply = {
        status: 200,
        body: JSON.stringify({
          model: 'jev-latest',
          answers: { is_urgent: { type: 'noul' } },
          usage: {},
        }),
      };

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state: 'x' });

      expect(res.status).toBe(502);
      expect(res.body.error.message).toContain('is_urgent');
    });

    test('502 when a choice answer carries a non-numeric probability', async () => {
      stubReply = {
        status: 200,
        body: JSON.stringify({
          model: 'jev-latest',
          answers: {
            department: {
              type: 'choice',
              choice: 'technical',
              probabilities: { technical: 'high' },
              confidence: 0.6,
            },
          },
          usage: {},
        }),
      };

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state: 'x' });

      expect(res.status).toBe(502);
    });

    test('502 when a choice answer carries no probabilities', async () => {
      stubReply = {
        status: 200,
        body: JSON.stringify({
          answers: {
            department: {
              type: 'choice',
              choice: 'technical',
              confidence: 0.6,
            },
          },
        }),
      };

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state: 'x' });

      expect(res.status).toBe(502);
    });

    test('502 when a score answer carries a non-string legend label', async () => {
      stubReply = {
        status: 200,
        body: JSON.stringify({
          model: 'jev-latest',
          answers: {
            frustration: {
              type: 'score',
              score: 1,
              legend: { '0': 7 },
              confidence: 0.8,
            },
          },
          usage: {},
        }),
      };

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state: 'x' });

      expect(res.status).toBe(502);
    });

    test('502 when a score answer carries no legend', async () => {
      stubReply = {
        status: 200,
        body: JSON.stringify({
          answers: {
            frustration: { type: 'score', score: 1, confidence: 0.8 },
          },
        }),
      };

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state: 'x' });

      expect(res.status).toBe(502);
    });

    test('502 when an answer names an unknown type', async () => {
      stubReply = {
        status: 200,
        body: JSON.stringify({
          model: 'jev-latest',
          answers: { q: { type: 'ranking', rank: 1 } },
          usage: {},
        }),
      };

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state: 'x' });

      expect(res.status).toBe(502);
    });

    test('502 when an answer is not an object', async () => {
      stubReply = {
        status: 200,
        body: JSON.stringify({ answers: { q: 'technical' } }),
      };

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state: 'x' });

      expect(res.status).toBe(502);
    });

    test('a score answer without probabilities is still accepted', async () => {
      stubReply = {
        status: 200,
        body: JSON.stringify({
          answers: {
            frustration: {
              type: 'score',
              score: 2,
              legend: { '0': 'Calm', '1': 'Cross', '2': 'Angry' },
              confidence: 0.9,
            },
          },
        }),
      };

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state: 'x' });

      expect(res.status).toBe(201);
      expect(res.body.answers.frustration.probabilities).toBeUndefined();
      // Neither `model` nor `usage` was returned, so both fall back.
      expect(res.body.model).toBe('jev-latest');
      expect(res.body.usage.input_tokens).toBe(0);
    });

    test('502 when the provider cannot be reached', async () => {
      const deadSecret = await authenticatedTestClient(userToken)
        .post('/api/v1/secrets')
        .send({ project_id: projectId, name: 'Dead Key', value: 'dead' });

      const dead = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'TypeSafe Dead',
          provider: 'typesafe',
          default_model: 'jev-latest',
          // Port 1 on loopback: allowlisted by the suite, never listening.
          base_url: 'http://127.0.0.1:1',
          secret_id: deadSecret.body.id,
        });

      const decider = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'Unreachable',
          ai_provider_id: dead.body.id,
          questions: { a: { type: 'noul', instructions: 'A?' } },
        });

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${decider.body.id}/evaluate`)
        .send({ state: 'x' });

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('AI_PROVIDER_ERROR');
    });

    test('400 when the provider links no secret', async () => {
      const noSecret = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'TypeSafe No Secret',
          provider: 'typesafe',
          default_model: 'jev-latest',
        });

      const decider = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'No Credential',
          ai_provider_id: noSecret.body.id,
          questions: { a: { type: 'noul', instructions: 'A?' } },
        });

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${decider.body.id}/evaluate`)
        .send({ state: 'x' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AI_PROVIDER_MISCONFIGURED');
    });

    test('400 when state is missing', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({});
      expect(res.status).toBe(400);
    });

    test('400 when state is an empty string', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state: '' });
      expect(res.status).toBe(400);
    });

    test('401 without a token', async () => {
      const res = await testClient
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state: 'x' });
      expect(res.status).toBe(401);
    });

    test('403 for a caller without the action', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/deciders/${deciderId}/evaluate`)
        .send({ state: 'x' });
      expect([403, 404]).toContain(res.status);
    });
  });

  describe('GET /api/v1/decisions', () => {
    test('lists decisions filtered by decider', async () => {
      const res = await authenticatedTestClient(userToken)
        .get(
          `/api/v1/decisions?project_id=${projectId}&decider_id=${deciderId}`
        )
        .send();

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(
        res.body.data.every((d: { decider_id: string }) => {
          return d.decider_id === deciderId;
        })
      ).toBe(true);
    });

    test('lists every decision in the project without a filter', async () => {
      const res = await authenticatedTestClient(userToken)
        .get(`/api/v1/decisions?project_id=${projectId}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.total).toBeGreaterThan(0);
    });

    test('401 without a token', async () => {
      const res = await testClient.get('/api/v1/decisions').send();
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/decisions/{decision_id}', () => {
    test('404 for an unknown decision', async () => {
      const res = await authenticatedTestClient(userToken)
        .get('/api/v1/decisions/dec_doesnotexist')
        .send();
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/deciders/{decider_id}', () => {
    test('deletes the decider but keeps its decisions', async () => {
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/deciders')
        .send({
          project_id: projectId,
          name: 'Delete Me',
          ai_provider_id: aiProviderId,
          questions: { a: { type: 'noul', instructions: 'A?' } },
        });

      const decision = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${created.body.id}/evaluate`)
        .send({ state: 'x' });

      const res = await authenticatedTestClient(userToken)
        .delete(`/api/v1/deciders/${created.body.id}`)
        .send();
      expect(res.status).toBe(204);

      const after = await authenticatedTestClient(userToken)
        .get(`/api/v1/deciders/${created.body.id}`)
        .send();
      expect(after.status).toBe(404);

      // The decision outlives the decider, holding its id as a dangling
      // reference.
      const kept = await authenticatedTestClient(userToken)
        .get(`/api/v1/decisions/${decision.body.id}`)
        .send();
      expect(kept.status).toBe(200);
      expect(kept.body.decider_id).toBe(created.body.id);
    });

    test('403 for a caller without the action', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .delete(`/api/v1/deciders/${deciderId}`)
        .send();
      expect([403, 404]).toContain(res.status);
    });
  });

  test('admin token reaches the module', async () => {
    const res = await authenticatedTestClient(adminToken)
      .get(`/api/v1/deciders?project_id=${projectId}`)
      .send();
    expect(res.status).toBe(200);
  });
});

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
  textCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient } from '../../testClient';

/**
 * A conversation or session turn carries `file_ids`, sent to the model natively
 * whenever the turn is replayed into a generation.
 */

const IMAGE_BYTES = Buffer.from('conversation-image-bytes');
const IMAGE_DATA_URL = `data:image/png;base64,${IMAGE_BYTES.toString('base64')}`;

describe('file ids on conversation turns', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  let imageFileId: string;
  let otherProjectFileId: string;
  let agentId: string;
  let textOnlyAgentId: string;
  let stub: ChatCompletionsStub;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const upload = async (args: { projectId: string }): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/files/upload')
      .attach('file', IMAGE_BYTES, {
        filename: 'photo.png',
        contentType: 'image/png',
      })
      .field('project_id', args.projectId);
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createAgent = async (args: {
    name: string;
    modelInputModalities?: Record<string, string[]>;
  }): Promise<string> => {
    const provider = await asAdmin()
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: `${args.name} provider`,
        provider: 'ollama',
        default_model: 'conversation-model',
        base_url: stub.baseUrl,
        ...(args.modelInputModalities
          ? { model_input_modalities: args.modelInputModalities }
          : {}),
      });
    expect(provider.status).toBe(201);
    const agent = await asAdmin().post('/api/v1/agents').send({
      project_id: projectId,
      name: args.name,
      ai_provider_id: provider.body.id,
    });
    expect(agent.status).toBe(201);
    return agent.body.id;
  };

  const createConversation = async (): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/conversations')
      .send({ project_id: projectId });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const lastRequestBody = (): string => {
    return JSON.stringify(stub.completions[stub.completions.length - 1].body);
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub();
    stub.reply(textCompletion('seen'));
    const setup = await setupProjectWithUsers({
      prefix: 'convfiles',
      policyActions: [
        'conversations:CreateConversation',
        'conversations:GetConversation',
        'conversations:UpdateConversation',
      ],
      createOtherProject: true,
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;
    imageFileId = await upload({ projectId });
    otherProjectFileId = await upload({ projectId: otherProjectId });
    agentId = await createAgent({ name: 'conversation reader' });
    textOnlyAgentId = await createAgent({
      name: 'conversation text reader',
      modelInputModalities: { 'conversation-model': ['text'] },
    });
  });

  afterAll(async () => {
    await stub.close();
  });

  describe('POST /api/v1/conversations/:conversation_id/messages', () => {
    test('stores the file ids and lists them', async () => {
      const conversationId = await createConversation();

      const added = await asAdmin()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .send({ role: 'user', message: 'Look', file_ids: [imageFileId] });

      expect(added.status).toBe(201);
      expect(added.body.file_ids).toEqual([imageFileId]);
      const listed = await asAdmin().get(
        `/api/v1/conversations/${conversationId}/messages`
      );
      expect(listed.status).toBe(200);
      expect(listed.body.data[0].file_ids).toEqual([imageFileId]);
    });

    test('a turn without files lists none', async () => {
      const conversationId = await createConversation();

      const added = await asAdmin()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .send({ role: 'user', message: 'Plain' });

      expect(added.status).toBe(201);
      expect(added.body.file_ids).toEqual([]);
    });

    test('refuses file ids on an assistant turn', async () => {
      const conversationId = await createConversation();

      const res = await asAdmin()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .send({ role: 'assistant', message: 'Here', file_ids: [imageFileId] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test("a file outside the conversation's project is not found", async () => {
      const conversationId = await createConversation();

      const res = await asAdmin()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .send({
          role: 'user',
          message: 'Look',
          file_ids: [otherProjectFileId],
        });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('the writer needs files:DownloadFile on each file', async () => {
      const conversation = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ project_id: projectId });
      expect(conversation.status).toBe(201);

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/conversations/${conversation.body.id}/messages`)
        .send({ role: 'user', message: 'Look', file_ids: [imageFileId] });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/v1/conversations/:conversation_id/generate', () => {
    test('sends each file to the model natively', async () => {
      const conversationId = await createConversation();
      await asAdmin()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .send({ role: 'user', message: 'Look', file_ids: [imageFileId] });

      const res = await asAdmin()
        .post(`/api/v1/conversations/${conversationId}/generate?wait=true`)
        .send({ agent_id: agentId });

      expect(res.status).toBe(200);
      expect(lastRequestBody()).toContain(IMAGE_DATA_URL);
    });

    test('a model that declares it cannot read the file refuses it', async () => {
      const conversationId = await createConversation();
      await asAdmin()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .send({ role: 'user', message: 'Look', file_ids: [imageFileId] });
      const before = stub.completions.length;

      const res = await asAdmin()
        .post(`/api/v1/conversations/${conversationId}/generate?wait=true`)
        .send({ agent_id: textOnlyAgentId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INPUT_MODALITY_UNSUPPORTED');
      expect(stub.completions.length).toBe(before);
    });
  });

  describe('POST /api/v1/sessions/:session_id/messages', () => {
    const createSession = async (): Promise<string> => {
      const res = await asAdmin()
        .post('/api/v1/sessions')
        .send({ agent_id: agentId });
      expect(res.status).toBe(201);
      return res.body.id;
    };

    test('accepts files without text and sends them to the model', async () => {
      const sessionId = await createSession();

      const added = await asAdmin()
        .post(`/api/v1/sessions/${sessionId}/messages`)
        .send({ file_ids: [imageFileId] });
      expect(added.status).toBe(201);

      const generated = await asAdmin().post(
        `/api/v1/sessions/${sessionId}/generate?wait=true`
      );

      expect(generated.status).toBe(200);
      expect(lastRequestBody()).toContain(IMAGE_DATA_URL);
    });

    test('refuses file ids beside a document', async () => {
      const sessionId = await createSession();

      const res = await asAdmin()
        .post(`/api/v1/sessions/${sessionId}/messages`)
        .send({ file_ids: [imageFileId], document_id: 'doc_x' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a body with neither text, files nor a document', async () => {
      const sessionId = await createSession();

      const res = await asAdmin()
        .post(`/api/v1/sessions/${sessionId}/messages`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});

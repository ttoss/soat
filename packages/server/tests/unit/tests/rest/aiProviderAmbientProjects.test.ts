import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

const ALLOW = 'AI_PROVIDER_ALLOW_AMBIENT_CREDENTIALS';
const PROJECTS = 'AI_PROVIDER_AMBIENT_CREDENTIAL_PROJECTS';

// The deployment's own credentials serve only the projects the operator names:
// any other project's credential-less record is refused at write and at use.
describe('ambient credentials scoped to named projects', () => {
  const previous = {
    allow: process.env[ALLOW],
    projects: process.env[PROJECTS],
  };
  let adminToken: string;
  let projectId: string;
  let otherProjectId: string;
  let otherProviderId: string;

  const credentialLess = (args: { projectId: string; name: string }) => {
    return {
      project_id: args.projectId,
      name: args.name,
      provider: 'bedrock',
      default_model: 'anthropic.claude-3-haiku-20240307-v1:0',
      config: { region: 'us-east-1' },
    };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'aiprovambient',
      policyActions: [],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;

    // A record written while the opt-in still covered every project.
    process.env[ALLOW] = 'true';
    delete process.env[PROJECTS];
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send(credentialLess({ projectId: otherProjectId, name: 'Earlier' }));
    expect(res.status).toBe(201);
    otherProviderId = res.body.id;

    process.env[PROJECTS] = ` ${projectId} , proj_unrelated`;
  });

  afterAll(() => {
    for (const [key, value] of [
      [ALLOW, previous.allow],
      [PROJECTS, previous.projects],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('POST /api/v1/ai-providers', () => {
    test('accepts a credential-less record in a named project', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send(credentialLess({ projectId, name: 'Named' }));
      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
    });

    test('refuses a credential-less record in any other project', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send(credentialLess({ projectId: otherProjectId, name: 'Other' }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toContain(PROJECTS);
    });
  });

  describe('POST /api/v1/formations', () => {
    test('refuses a credential-less record in an unnamed project', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({
          project_id: otherProjectId,
          name: 'ambient-other-stack',
          template: {
            resources: {
              Provider: {
                type: 'ai_provider',
                properties: {
                  name: 'ambient-formation-provider',
                  provider: 'bedrock',
                  default_model: 'anthropic.claude-3-haiku-20240307-v1:0',
                  config: { region: 'us-east-1' },
                },
              },
            },
          },
        });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(res.body.error.message).toContain(PROJECTS);
    });

    test('creates a credential-less record in a named project', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'ambient-named-stack',
          template: {
            resources: {
              Provider: {
                type: 'ai_provider',
                properties: {
                  name: 'ambient-formation-provider',
                  provider: 'bedrock',
                  default_model: 'anthropic.claude-3-haiku-20240307-v1:0',
                  config: { region: 'us-east-1' },
                },
              },
            },
          },
        });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
    });
  });

  describe('POST /api/v1/chat/completions', () => {
    test('refuses a stored record of an unnamed project at generation', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: otherProviderId,
          messages: [{ role: 'user', content: 'Hello' }],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AI_PROVIDER_MISCONFIGURED');
      expect(res.body.error.message).toContain(PROJECTS);
    });
  });

  describe('GET /api/v1/ai-providers/{ai_provider_id}/models', () => {
    test('refuses a stored record of an unnamed project at listing', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/ai-providers/${otherProviderId}/models`
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AI_PROVIDER_MISCONFIGURED');
    });
  });
});

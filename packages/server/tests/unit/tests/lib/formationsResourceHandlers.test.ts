import { db } from 'src/db';
import { getFormationModule } from 'src/lib/formationsRegistry';
import {
  applyCreateResource,
  applyDeleteResource,
  applyUpdateResource,
} from 'src/lib/formationsResourceHandlers';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * These tests exercise the real formation-module handlers against a live
 * database — no internal `spyOn` substitution. Each `applyCreateResource` /
 * `applyUpdateResource` / `applyDeleteResource` call runs the real lib
 * function, and the effect is verified by reading the resource back through the
 * matching formation module's `read` (the same drift-detection read the apply
 * flow uses in production). Every resource type and operation gets its own test
 * so a regression localizes to a single resource/operation rather than a
 * mega-test.
 */
describe('formationsResourceHandlers', () => {
  let adminToken: string;
  let projectId: string;
  let projectDbId: number;

  // Prerequisite resources created once, referenced by the per-resource tests.
  let secretId: string;
  let memoryId: string;
  let aiProviderId: string;
  let agentId: string;

  const readResource = async (
    resourceType: string,
    physicalResourceId: string
  ) => {
    const formationModule = getFormationModule({ resourceType });
    if (!formationModule?.read) {
      throw new Error(`No read handler for resource type: ${resourceType}`);
    }
    return formationModule.read({ physicalResourceId });
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'frhadmin', password: 'supersecret' });
    adminToken = await loginAs('frhadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Formation Resource Handlers Project' });
    projectId = projectRes.body.id;

    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectDbId = project?.id as number;

    const secretRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'frh-secret', value: 'sk-secret' });
    secretId = secretRes.body.id;

    const memoryRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/memories')
      .send({ project_id: projectId, name: 'frh-prereq-memory' });
    memoryId = memoryRes.body.id;

    const aiProviderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'frh-prereq-provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = aiProviderRes.body.id;

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: 'frh-prereq-agent',
      });
    agentId = agentRes.body.id;
  });

  describe('applyCreateResource', () => {
    test('creates ai_provider with resolved secret', async () => {
      const id = await applyCreateResource({
        resourceType: 'ai_provider',
        projectId: projectDbId,
        resolvedProperties: {
          name: 'frh-create-provider',
          provider: 'ollama',
          default_model: 'llama3.2',
          secret_id: secretId,
          base_url: 'https://api.example.com',
          config: { region: 'us' },
        },
      });

      expect(id).toMatch(/^aip_/);
      const read = await readResource('ai_provider', id);
      expect(read).toMatchObject({
        name: 'frh-create-provider',
        provider: 'ollama',
        default_model: 'llama3.2',
        base_url: 'https://api.example.com',
        config: { region: 'us' },
        secret_id: secretId,
      });
    });

    test('creates tool', async () => {
      const id = await applyCreateResource({
        resourceType: 'tool',
        projectId: projectDbId,
        resolvedProperties: {
          type: 'http',
          name: 'frh-create-tool',
          description: 'Search tool',
          parameters: { type: 'object' },
          execute: { url: 'https://example.com' },
          actions: ['read'],
          preset_parameters: { limit: 5 },
        },
      });

      expect(id).toMatch(/^tool_/);
      const read = await readResource('tool', id);
      expect(read).toMatchObject({
        name: 'frh-create-tool',
        type: 'http',
        description: 'Search tool',
        parameters: { type: 'object' },
        execute: { url: 'https://example.com' },
        actions: ['read'],
        preset_parameters: { limit: 5 },
      });
    });

    test('creates actor with resolved linked ids', async () => {
      const id = await applyCreateResource({
        resourceType: 'actor',
        projectId: projectDbId,
        resolvedProperties: {
          name: 'frh-create-actor',
          external_id: 'whatsapp:+5511999999999',
          instructions: 'Talk like support',
          agent_id: agentId,
          memory_id: memoryId,
          auto_create_memory: false,
        },
      });

      expect(id).toMatch(/^actor_/);
      const read = await readResource('actor', id);
      expect(read).toMatchObject({
        name: 'frh-create-actor',
        external_id: 'whatsapp:+5511999999999',
        instructions: 'Talk like support',
        agent_id: agentId,
        memory_id: memoryId,
      });
    });

    test('creates agent', async () => {
      const id = await applyCreateResource({
        resourceType: 'agent',
        projectId: projectDbId,
        resolvedProperties: {
          ai_provider_id: aiProviderId,
          name: 'frh-create-agent',
          instructions: 'Be precise',
          model: 'llama3.2',
          max_steps: 5,
          temperature: 0.2,
        },
      });

      expect(id).toMatch(/^agent_/);
      const read = await readResource('agent', id);
      expect(read).toMatchObject({
        ai_provider_id: aiProviderId,
        name: 'frh-create-agent',
        instructions: 'Be precise',
        model: 'llama3.2',
        max_steps: 5,
        temperature: 0.2,
      });
    });

    test('creates document', async () => {
      const id = await applyCreateResource({
        resourceType: 'document',
        projectId: projectDbId,
        resolvedProperties: {
          content: 'Doc body',
          path: 'docs/guide.md',
          filename: 'guide.md',
          title: 'Guide',
          metadata: { version: '1' },
          tags: { topic: 'test' },
        },
      });

      expect(id).toMatch(/^doc_/);
      const read = await readResource('document', id);
      expect(read).toMatchObject({
        content: 'Doc body',
        filename: 'guide.md',
        title: 'Guide',
        tags: { topic: 'test' },
      });
    });

    test('creates memory', async () => {
      const id = await applyCreateResource({
        resourceType: 'memory',
        projectId: projectDbId,
        resolvedProperties: {
          name: 'frh-create-memory',
          description: 'Important facts',
          tags: ['core', 'shared'],
        },
      });

      expect(id).toMatch(/^mem_/);
      const read = await readResource('memory', id);
      expect(read).toMatchObject({
        name: 'frh-create-memory',
        description: 'Important facts',
        tags: ['core', 'shared'],
      });
    });

    test('creates memory_entry with resolved memory internal id', async () => {
      const id = await applyCreateResource({
        resourceType: 'memory_entry',
        projectId: projectDbId,
        resolvedProperties: {
          memory_id: memoryId,
          content: 'Remember this',
          source_type: 'manual',
        },
      });

      expect(id).toMatch(/^mem_entry_/);
      const read = await readResource('memory_entry', id);
      expect(read).toMatchObject({
        memory_id: memoryId,
        content: 'Remember this',
        source_type: 'manual',
      });
    });

    test('creates webhook', async () => {
      const id = await applyCreateResource({
        resourceType: 'webhook',
        projectId: projectDbId,
        resolvedProperties: {
          name: 'frh-create-webhook',
          description: 'Webhook description',
          url: 'https://example.com/webhook',
          events: ['memory.created'],
        },
      });

      expect(id).toMatch(/^wh_/);
      const read = await readResource('webhook', id);
      expect(read).toMatchObject({
        name: 'frh-create-webhook',
        description: 'Webhook description',
        url: 'https://example.com/webhook',
        events: ['memory.created'],
      });
    });

    test('throws when agent creation references a missing ai provider', async () => {
      await expect(
        applyCreateResource({
          resourceType: 'agent',
          projectId: projectDbId,
          resolvedProperties: {
            ai_provider_id: 'aip_missing',
            name: 'frh-broken-agent',
          },
        })
      ).rejects.toThrow(/not found/i);
    });

    test('throws for unsupported create resource type', async () => {
      await expect(
        applyCreateResource({
          resourceType: 'unsupported',
          projectId: projectDbId,
          resolvedProperties: {},
        })
      ).rejects.toThrow('Unsupported resource type: unsupported');
    });

    test('throws when actor create has both agent_id and chat_id', async () => {
      await expect(
        applyCreateResource({
          resourceType: 'actor',
          projectId: projectDbId,
          resolvedProperties: {
            name: 'frh-exclusive-actor',
            agent_id: agentId,
            chat_id: 'chat_1',
          },
        })
      ).rejects.toThrow('agentId and chatId are mutually exclusive');
    });

    test('throws when actor create name is empty string', async () => {
      await expect(
        applyCreateResource({
          resourceType: 'actor',
          projectId: projectDbId,
          resolvedProperties: {
            name: '',
          },
        })
      ).rejects.toThrow("Actor field 'name' must be a non-empty string");
    });
  });

  describe('applyUpdateResource', () => {
    test('updates ai_provider with resolved secret', async () => {
      const id = await applyCreateResource({
        resourceType: 'ai_provider',
        projectId: projectDbId,
        resolvedProperties: {
          name: 'frh-update-provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        },
      });

      await expect(
        applyUpdateResource({
          resourceType: 'ai_provider',
          physicalResourceId: id,
          resolvedProperties: {
            name: 'frh-update-provider-v2',
            provider: 'ollama',
            default_model: 'llama3.1',
            secret_id: secretId,
            base_url: null,
            config: null,
          },
        })
      ).resolves.toBeUndefined();

      const read = await readResource('ai_provider', id);
      expect(read).toMatchObject({
        name: 'frh-update-provider-v2',
        default_model: 'llama3.1',
        secret_id: secretId,
      });
    });

    test('updates tool', async () => {
      const id = await applyCreateResource({
        resourceType: 'tool',
        projectId: projectDbId,
        resolvedProperties: {
          type: 'http',
          name: 'frh-update-tool',
          execute: { url: 'https://example.com' },
        },
      });

      await expect(
        applyUpdateResource({
          resourceType: 'tool',
          physicalResourceId: id,
          resolvedProperties: {
            name: 'frh-update-tool-v2',
            execute: { url: 'https://example.com/v2' },
          },
        })
      ).resolves.toBeUndefined();

      const read = await readResource('tool', id);
      expect(read).toMatchObject({
        name: 'frh-update-tool-v2',
        execute: { url: 'https://example.com/v2' },
      });
    });

    test('updates actor', async () => {
      const id = await applyCreateResource({
        resourceType: 'actor',
        projectId: projectDbId,
        resolvedProperties: { name: 'frh-update-actor' },
      });

      await expect(
        applyUpdateResource({
          resourceType: 'actor',
          physicalResourceId: id,
          resolvedProperties: {
            name: 'frh-update-actor-v2',
            instructions: 'Updated instructions',
            agent_id: agentId,
          },
        })
      ).resolves.toBeUndefined();

      const read = await readResource('actor', id);
      expect(read).toMatchObject({
        name: 'frh-update-actor-v2',
        instructions: 'Updated instructions',
        agent_id: agentId,
      });
    });

    test('updates agent', async () => {
      const id = await applyCreateResource({
        resourceType: 'agent',
        projectId: projectDbId,
        resolvedProperties: {
          ai_provider_id: aiProviderId,
          name: 'frh-update-agent',
        },
      });

      await expect(
        applyUpdateResource({
          resourceType: 'agent',
          physicalResourceId: id,
          resolvedProperties: {
            name: 'frh-update-agent-v2',
            instructions: 'New instructions',
            model: 'llama3.1',
            max_steps: 8,
            temperature: 0.5,
          },
        })
      ).resolves.toBeUndefined();

      const read = await readResource('agent', id);
      expect(read).toMatchObject({
        name: 'frh-update-agent-v2',
        instructions: 'New instructions',
        model: 'llama3.1',
        max_steps: 8,
        temperature: 0.5,
      });
    });

    test('updates memory', async () => {
      const id = await applyCreateResource({
        resourceType: 'memory',
        projectId: projectDbId,
        resolvedProperties: {
          name: 'frh-update-memory',
          description: 'original',
        },
      });

      await expect(
        applyUpdateResource({
          resourceType: 'memory',
          physicalResourceId: id,
          resolvedProperties: {
            name: 'frh-update-memory-v2',
            description: null,
            tags: null,
          },
        })
      ).resolves.toBeUndefined();

      const read = await readResource('memory', id);
      expect(read).toMatchObject({ name: 'frh-update-memory-v2' });
    });

    test('updates memory_entry', async () => {
      const id = await applyCreateResource({
        resourceType: 'memory_entry',
        projectId: projectDbId,
        resolvedProperties: {
          memory_id: memoryId,
          content: 'old content',
          source_type: 'manual',
        },
      });

      await expect(
        applyUpdateResource({
          resourceType: 'memory_entry',
          physicalResourceId: id,
          resolvedProperties: { content: 'new content' },
        })
      ).resolves.toBeUndefined();

      const read = await readResource('memory_entry', id);
      expect(read).toMatchObject({ content: 'new content' });
    });

    test('updates webhook', async () => {
      const id = await applyCreateResource({
        resourceType: 'webhook',
        projectId: projectDbId,
        resolvedProperties: {
          name: 'frh-update-webhook',
          url: 'https://example.com/webhook',
          events: ['memory.created'],
        },
      });

      await expect(
        applyUpdateResource({
          resourceType: 'webhook',
          physicalResourceId: id,
          resolvedProperties: {
            name: 'frh-update-webhook-v2',
            description: 'Updated description',
            url: 'https://example.com/hook',
            events: ['memory.updated'],
          },
        })
      ).resolves.toBeUndefined();

      const read = await readResource('webhook', id);
      expect(read).toMatchObject({
        name: 'frh-update-webhook-v2',
        description: 'Updated description',
        url: 'https://example.com/hook',
        events: ['memory.updated'],
      });
    });

    test('applies document update (content + title)', async () => {
      const id = await applyCreateResource({
        resourceType: 'document',
        projectId: projectDbId,
        resolvedProperties: { content: 'Original body', title: 'Original' },
      });

      await expect(
        applyUpdateResource({
          resourceType: 'document',
          physicalResourceId: id,
          resolvedProperties: { content: 'Updated body', title: 'Updated' },
        })
      ).resolves.toBeUndefined();

      const read = await readResource('document', id);
      expect(read).toMatchObject({
        content: 'Updated body',
        title: 'Updated',
      });
    });

    test('throws when agent to update is missing', async () => {
      await expect(
        applyUpdateResource({
          resourceType: 'agent',
          physicalResourceId: 'agt_missing',
          resolvedProperties: { name: 'x' },
        })
      ).rejects.toThrow(/not found/i);
    });

    test('throws when memory_entry to update is missing', async () => {
      await expect(
        applyUpdateResource({
          resourceType: 'memory_entry',
          physicalResourceId: 'men_missing',
          resolvedProperties: { content: 'x' },
        })
      ).rejects.toThrow('MemoryEntry not found: men_missing');
    });

    test('throws for unsupported update resource type', async () => {
      await expect(
        applyUpdateResource({
          resourceType: 'unsupported',
          physicalResourceId: 'res_1',
          resolvedProperties: {},
        })
      ).rejects.toThrow('Unsupported resource type for update: unsupported');
    });

    test('throws when actor update has both agent_id and chat_id', async () => {
      const id = await applyCreateResource({
        resourceType: 'actor',
        projectId: projectDbId,
        resolvedProperties: { name: 'frh-update-exclusive-actor' },
      });

      await expect(
        applyUpdateResource({
          resourceType: 'actor',
          physicalResourceId: id,
          resolvedProperties: {
            name: 'frh-update-exclusive-actor',
            agent_id: agentId,
            chat_id: 'chat_1',
          },
        })
      ).rejects.toThrow('agentId and chatId are mutually exclusive');
    });
  });

  describe('applyDeleteResource', () => {
    test('deletes ai_provider', async () => {
      const id = await applyCreateResource({
        resourceType: 'ai_provider',
        projectId: projectDbId,
        resolvedProperties: {
          name: 'frh-delete-provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        },
      });

      await applyDeleteResource({
        resourceType: 'ai_provider',
        physicalResourceId: id,
      });
      expect(await readResource('ai_provider', id)).toBeNull();
    });

    test('deletes tool', async () => {
      const id = await applyCreateResource({
        resourceType: 'tool',
        projectId: projectDbId,
        resolvedProperties: {
          type: 'http',
          name: 'frh-delete-tool',
          execute: { url: 'https://example.com' },
        },
      });

      await applyDeleteResource({
        resourceType: 'tool',
        physicalResourceId: id,
      });
      expect(await readResource('tool', id)).toBeNull();
    });

    test('deletes agent', async () => {
      const id = await applyCreateResource({
        resourceType: 'agent',
        projectId: projectDbId,
        resolvedProperties: {
          ai_provider_id: aiProviderId,
          name: 'frh-delete-agent',
        },
      });

      await applyDeleteResource({
        resourceType: 'agent',
        physicalResourceId: id,
      });
      expect(await readResource('agent', id)).toBeNull();
    });

    test('deletes actor', async () => {
      const id = await applyCreateResource({
        resourceType: 'actor',
        projectId: projectDbId,
        resolvedProperties: { name: 'frh-delete-actor' },
      });

      await applyDeleteResource({
        resourceType: 'actor',
        physicalResourceId: id,
      });
      expect(await readResource('actor', id)).toBeNull();
    });

    test('deletes document', async () => {
      const id = await applyCreateResource({
        resourceType: 'document',
        projectId: projectDbId,
        resolvedProperties: { content: 'delete me' },
      });

      await applyDeleteResource({
        resourceType: 'document',
        physicalResourceId: id,
      });
      expect(await readResource('document', id)).toBeNull();
    });

    test('deletes memory', async () => {
      const id = await applyCreateResource({
        resourceType: 'memory',
        projectId: projectDbId,
        resolvedProperties: { name: 'frh-delete-memory' },
      });

      await applyDeleteResource({
        resourceType: 'memory',
        physicalResourceId: id,
      });
      expect(await readResource('memory', id)).toBeNull();
    });

    test('deletes memory_entry', async () => {
      const id = await applyCreateResource({
        resourceType: 'memory_entry',
        projectId: projectDbId,
        resolvedProperties: { memory_id: memoryId, content: 'delete me' },
      });

      await applyDeleteResource({
        resourceType: 'memory_entry',
        physicalResourceId: id,
      });
      expect(await readResource('memory_entry', id)).toBeNull();
    });

    test('deletes webhook', async () => {
      const id = await applyCreateResource({
        resourceType: 'webhook',
        projectId: projectDbId,
        resolvedProperties: {
          name: 'frh-delete-webhook',
          url: 'https://example.com/webhook',
          events: ['memory.created'],
        },
      });

      await applyDeleteResource({
        resourceType: 'webhook',
        physicalResourceId: id,
      });
      expect(await readResource('webhook', id)).toBeNull();
    });

    test('throws for unsupported delete resource type', async () => {
      await expect(
        applyDeleteResource({
          resourceType: 'unsupported',
          physicalResourceId: 'res_1',
        })
      ).rejects.toThrow('Unsupported resource type for delete: unsupported');
    });
  });
});

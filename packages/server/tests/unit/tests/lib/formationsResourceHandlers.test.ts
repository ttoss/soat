import { DomainError } from 'src/errors';
import { db } from 'src/db';
import {
  applyCreateResource,
  applyDeleteResource,
  applyUpdateResource,
} from 'src/lib/formationsResourceHandlers';
import * as actorsModule from 'src/lib/actors';
import * as helpersModule from 'src/lib/formationsHelpers';
import * as agentsModule from 'src/lib/agents';
import * as agentToolsCrudModule from 'src/lib/agentToolsCrud';
import * as aiProvidersModule from 'src/lib/aiProviders';
import * as documentsModule from 'src/lib/documents';
import * as memoriesModule from 'src/lib/memories';
import * as memoryEntriesModule from 'src/lib/memoryEntries';
import * as webhooksModule from 'src/lib/webhooks';

const mockLookupMemoryInternalId = jest.spyOn(
  helpersModule,
  'lookupMemoryInternalId'
);
const mockLookupAgentInternalId = jest.spyOn(
  helpersModule,
  'lookupAgentInternalId'
);
const mockLookupSecretInternalId = jest.spyOn(
  helpersModule,
  'lookupSecretInternalId'
);
const mockCreateActor = jest.spyOn(actorsModule, 'createActor');
const mockUpdateActor = jest.spyOn(actorsModule, 'updateActor');
const mockDeleteActor = jest.spyOn(actorsModule, 'deleteActor');
const mockCreateAgent = jest.spyOn(agentsModule, 'createAgent');
const mockUpdateAgent = jest.spyOn(agentsModule, 'updateAgent');
const mockDeleteAgent = jest.spyOn(agentsModule, 'deleteAgent');
const mockCreateAgentTool = jest.spyOn(agentToolsCrudModule, 'createAgentTool');
const mockDeleteAgentTool = jest.spyOn(agentToolsCrudModule, 'deleteAgentTool');
const mockUpdateAgentTool = jest.spyOn(agentToolsCrudModule, 'updateAgentTool');
const mockCreateAiProvider = jest.spyOn(aiProvidersModule, 'createAiProvider');
const mockDeleteAiProvider = jest.spyOn(aiProvidersModule, 'deleteAiProvider');
const mockUpdateAiProvider = jest.spyOn(aiProvidersModule, 'updateAiProvider');
const mockCreateDocument = jest.spyOn(documentsModule, 'createDocument');
const mockDeleteDocument = jest.spyOn(documentsModule, 'deleteDocument');
const mockCreateMemory = jest.spyOn(memoriesModule, 'createMemory');
const mockDeleteMemory = jest.spyOn(memoriesModule, 'deleteMemory');
const mockUpdateMemory = jest.spyOn(memoriesModule, 'updateMemory');
const mockCreateMemoryEntry = jest.spyOn(
  memoryEntriesModule,
  'createMemoryEntry'
);
const mockDeleteMemoryEntry = jest.spyOn(
  memoryEntriesModule,
  'deleteMemoryEntry'
);
const mockCreateWebhook = jest.spyOn(webhooksModule, 'createWebhook');
const mockDeleteWebhook = jest.spyOn(webhooksModule, 'deleteWebhook');
const mockUpdateWebhook = jest.spyOn(webhooksModule, 'updateWebhook');

afterEach(() => {
  jest.clearAllMocks();
});

describe('formationsResourceHandlers', () => {
  describe('applyCreateResource', () => {
    test('creates ai_provider with resolved secret, agent tool, actor, agent, document, memory, memory_entry, and webhook', async () => {
      mockLookupSecretInternalId.mockResolvedValueOnce(42);
      mockCreateAiProvider.mockResolvedValueOnce({
        id: 'aip_1',
      } as Awaited<ReturnType<typeof aiProvidersModule.createAiProvider>>);
      mockCreateAgentTool.mockResolvedValueOnce({
        id: 'at_1',
      } as Awaited<ReturnType<typeof agentToolsCrudModule.createAgentTool>>);
      mockLookupAgentInternalId.mockResolvedValueOnce(10);
      mockLookupMemoryInternalId.mockResolvedValueOnce(9);
      mockCreateActor.mockResolvedValueOnce({
        id: 'act_1',
      } as Awaited<ReturnType<typeof actorsModule.createActor>>);
      mockCreateAgent.mockResolvedValueOnce({
        id: 'agt_1',
      } as Awaited<ReturnType<typeof agentsModule.createAgent>>);
      mockCreateDocument.mockResolvedValueOnce({
        id: 'doc_1',
      } as Awaited<ReturnType<typeof documentsModule.createDocument>>);
      mockCreateMemory.mockResolvedValueOnce({
        id: 'mem_1',
      } as Awaited<ReturnType<typeof memoriesModule.createMemory>>);
      mockLookupMemoryInternalId.mockResolvedValueOnce(7);
      mockCreateMemoryEntry.mockResolvedValueOnce({
        id: 'me_1',
      } as Awaited<ReturnType<typeof memoryEntriesModule.createMemoryEntry>>);
      mockCreateWebhook.mockResolvedValueOnce({
        id: 'wh_1',
      } as Awaited<ReturnType<typeof webhooksModule.createWebhook>>);

      await expect(
        applyCreateResource({
          resourceType: 'ai_provider',
          projectId: 1,
          resolvedProperties: {
            name: 'Provider',
            provider: 'openai',
            default_model: 'gpt-4o',
            secret_id: 'sec_public',
            base_url: 'https://api.example.com',
            config: { region: 'us' },
          },
        })
      ).resolves.toBe('aip_1');

      await expect(
        applyCreateResource({
          resourceType: 'agent_tool',
          projectId: 1,
          resolvedProperties: {
            type: 'http',
            name: 'Search',
            description: 'Search tool',
            parameters: { type: 'object' },
            execute: { url: 'https://example.com' },
            mcp: { server: 'mcp-server' },
            actions: ['read'],
            preset_parameters: { limit: 5 },
          },
        })
      ).resolves.toBe('at_1');

      await expect(
        applyCreateResource({
          resourceType: 'actor',
          projectId: 1,
          resolvedProperties: {
            name: 'Customer Actor',
            external_id: 'whatsapp:+5511999999999',
            instructions: 'Talk like support',
            agent_id: 'agt_ref',
            memory_id: 'mem_ref',
            auto_create_memory: false,
          },
        })
      ).resolves.toBe('act_1');

      await expect(
        applyCreateResource({
          resourceType: 'agent',
          projectId: 1,
          resolvedProperties: {
            ai_provider_id: 'aip_1',
            name: 'Helper',
            instructions: 'Be precise',
            model: 'gpt-4o-mini',
            tool_ids: ['at_1'],
            max_steps: 5,
            tool_choice: { type: 'auto' },
            stop_conditions: [{ type: 'max_steps' }],
            active_tool_ids: ['at_1'],
            step_rules: [{ type: 'require_tool' }],
            boundary_policy: { mode: 'strict' },
            temperature: 0.2,
            knowledge_config: { topK: 3 },
          },
        })
      ).resolves.toBe('agt_1');

      await expect(
        applyCreateResource({
          resourceType: 'document',
          projectId: 1,
          resolvedProperties: {
            content: 'Doc body',
            path: 'docs/guide.md',
            filename: 'guide.md',
            title: 'Guide',
            metadata: { version: '1' },
            tags: { topic: 'test' },
          },
        })
      ).resolves.toBe('doc_1');

      await expect(
        applyCreateResource({
          resourceType: 'memory',
          projectId: 1,
          resolvedProperties: {
            name: 'Memory',
            description: 'Important facts',
            tags: ['core', 'shared'],
          },
        })
      ).resolves.toBe('mem_1');

      await expect(
        applyCreateResource({
          resourceType: 'memory_entry',
          projectId: 1,
          resolvedProperties: {
            memory_id: 'mem_public',
            content: 'Remember this',
            source: 'manual',
          },
        })
      ).resolves.toBe('me_1');

      await expect(
        applyCreateResource({
          resourceType: 'webhook',
          projectId: 1,
          resolvedProperties: {
            name: 'Hook',
            description: 'Webhook description',
            url: 'https://example.com/webhook',
            events: ['memory.created'],
          },
        })
      ).resolves.toBe('wh_1');

      expect(mockLookupSecretInternalId).toHaveBeenCalledWith('sec_public');
      expect(mockCreateAiProvider).toHaveBeenCalledWith({
        projectId: 1,
        secretId: 42,
        name: 'Provider',
        provider: 'openai',
        defaultModel: 'gpt-4o',
        baseUrl: 'https://api.example.com',
        config: { region: 'us' },
      });
      expect(mockCreateAgentTool).toHaveBeenCalledWith({
        projectId: 1,
        type: 'http',
        name: 'Search',
        description: 'Search tool',
        parameters: { type: 'object' },
        execute: { url: 'https://example.com' },
        mcp: { server: 'mcp-server' },
        actions: ['read'],
        presetParameters: { limit: 5 },
      });
      expect(mockLookupAgentInternalId).toHaveBeenCalledWith('agt_ref');
      expect(mockLookupMemoryInternalId).toHaveBeenCalledWith('mem_ref');
      expect(mockCreateActor).toHaveBeenCalledWith({
        projectId: 1,
        name: 'Customer Actor',
        externalId: 'whatsapp:+5511999999999',
        instructions: 'Talk like support',
        agentId: 10,
        chatId: undefined,
        memoryId: 9,
        autoCreateMemory: false,
      });
      expect(mockCreateAgent).toHaveBeenCalledWith({
        projectId: 1,
        aiProviderId: 'aip_1',
        name: 'Helper',
        instructions: 'Be precise',
        model: 'gpt-4o-mini',
        toolIds: ['at_1'],
        maxSteps: 5,
        toolChoice: { type: 'auto' },
        stopConditions: [{ type: 'max_steps' }],
        activeToolIds: ['at_1'],
        stepRules: [{ type: 'require_tool' }],
        boundaryPolicy: { mode: 'strict' },
        temperature: 0.2,
        knowledgeConfig: { topK: 3 },
      });
      expect(mockCreateDocument).toHaveBeenCalledWith({
        projectId: 1,
        content: 'Doc body',
        path: 'docs/guide.md',
        filename: 'guide.md',
        title: 'Guide',
        metadata: { version: '1' },
        tags: { topic: 'test' },
      });
      expect(mockCreateMemory).toHaveBeenCalledWith({
        projectId: 1,
        name: 'Memory',
        description: 'Important facts',
        tags: ['core', 'shared'],
      });
      expect(mockLookupMemoryInternalId).toHaveBeenLastCalledWith('mem_public');
      expect(mockCreateMemoryEntry).toHaveBeenCalledWith({
        memoryId: 7,
        content: 'Remember this',
        source: 'manual',
      });
      expect(mockCreateWebhook).toHaveBeenCalledWith({
        projectId: 1,
        name: 'Hook',
        description: 'Webhook description',
        url: 'https://example.com/webhook',
        events: ['memory.created'],
      });
    });

    test('throws when agent creation reports missing ai provider', async () => {
      mockCreateAgent.mockRejectedValueOnce(
        new DomainError(
          'AI_PROVIDER_NOT_FOUND',
          'AI provider not found: aip_missing'
        )
      );

      await expect(
        applyCreateResource({
          resourceType: 'agent',
          projectId: 1,
          resolvedProperties: {
            ai_provider_id: 'aip_missing',
            name: 'Broken agent',
          },
        })
      ).rejects.toThrow('AI provider not found: aip_missing');
    });

    test('throws for unsupported create resource type', async () => {
      await expect(
        applyCreateResource({
          resourceType: 'unsupported',
          projectId: 1,
          resolvedProperties: {},
        })
      ).rejects.toThrow('Unsupported resource type: unsupported');
    });
  });

  describe('applyUpdateResource', () => {
    test('updates ai_provider, agent_tool, actor, agent, memory, memory_entry, webhook, and ignores document', async () => {
      mockLookupSecretInternalId.mockResolvedValueOnce(84);
      mockUpdateActor.mockResolvedValueOnce({
        id: 'act_1',
      } as Awaited<ReturnType<typeof actorsModule.updateActor>>);
      mockUpdateAgentTool.mockResolvedValue(
        undefined as unknown as Awaited<
          ReturnType<typeof agentToolsCrudModule.updateAgentTool>
        >
      );
      mockUpdateAgent.mockResolvedValue(
        undefined as unknown as Awaited<
          ReturnType<typeof agentsModule.updateAgent>
        >
      );

      const memoryEntryInstance = db.MemoryEntry.build({
        publicId: 'men_1',
        memoryId: 1,
        content: 'old content',
        source: 'manual',
      });
      const entrySave = jest
        .spyOn(memoryEntryInstance, 'save')
        .mockResolvedValue(memoryEntryInstance);
      jest
        .spyOn(db.MemoryEntry, 'findOne')
        .mockResolvedValueOnce(memoryEntryInstance);

      await expect(
        applyUpdateResource({
          resourceType: 'ai_provider',
          physicalResourceId: 'aip_1',
          resolvedProperties: {
            name: 'Provider Updated',
            provider: 'openai',
            default_model: 'gpt-4.1',
            secret_id: 'sec_new',
            base_url: null,
            config: null,
          },
        })
      ).resolves.toBeUndefined();

      await expect(
        applyUpdateResource({
          resourceType: 'agent_tool',
          physicalResourceId: 'at_1',
          resolvedProperties: {
            name: 'Search Updated',
            description: null,
            parameters: null,
            execute: { url: 'https://example.com/v2' },
            mcp: null,
            actions: null,
            preset_parameters: null,
          },
        })
      ).resolves.toBeUndefined();

      await expect(
        applyUpdateResource({
          resourceType: 'actor',
          physicalResourceId: 'act_1',
          resolvedProperties: {
            name: 'Actor Updated',
            instructions: null,
            agent_id: 'agt_2',
          },
        })
      ).resolves.toBeUndefined();

      await expect(
        applyUpdateResource({
          resourceType: 'agent',
          physicalResourceId: 'agt_1',
          resolvedProperties: {
            name: 'Agent Updated',
            instructions: 'New instructions',
            model: 'gpt-4.1-mini',
            tool_ids: ['at_1'],
            max_steps: 8,
            tool_choice: { type: 'required' },
            stop_conditions: [{ type: 'stop' }],
            active_tool_ids: ['at_1'],
            step_rules: [{ type: 'must_call_tool' }],
            boundary_policy: { mode: 'audit' },
            temperature: 0.5,
            knowledge_config: { topK: 8 },
            ignored_value: undefined,
          },
        })
      ).resolves.toBeUndefined();

      await expect(
        applyUpdateResource({
          resourceType: 'memory',
          physicalResourceId: 'mem_1',
          resolvedProperties: {
            name: 'Memory Updated',
            description: null,
            tags: null,
          },
        })
      ).resolves.toBeUndefined();

      await expect(
        applyUpdateResource({
          resourceType: 'memory_entry',
          physicalResourceId: 'me_1',
          resolvedProperties: {
            content: 'new content',
          },
        })
      ).resolves.toBeUndefined();

      await expect(
        applyUpdateResource({
          resourceType: 'webhook',
          physicalResourceId: 'wh_1',
          resolvedProperties: {
            name: 'Hook Updated',
            description: 'Updated description',
            url: 'https://example.com/hook',
            events: ['memory.updated'],
          },
        })
      ).resolves.toBeUndefined();

      await expect(
        applyUpdateResource({
          resourceType: 'document',
          physicalResourceId: 'doc_1',
          resolvedProperties: {
            title: 'ignored',
          },
        })
      ).resolves.toBeUndefined();

      expect(mockUpdateAiProvider).toHaveBeenCalledWith({
        id: 'aip_1',
        secretId: 84,
        name: 'Provider Updated',
        provider: 'openai',
        defaultModel: 'gpt-4.1',
        baseUrl: null,
        config: null,
      });
      expect(mockUpdateAgentTool).toHaveBeenCalledWith({
        id: 'at_1',
        name: 'Search Updated',
        description: null,
        parameters: null,
        execute: { url: 'https://example.com/v2' },
        mcp: null,
        actions: null,
        presetParameters: null,
      });
      expect(mockUpdateActor).toHaveBeenCalledWith({
        id: 'act_1',
        name: 'Actor Updated',
        externalId: undefined,
        instructions: null,
        agentId: 'agt_2',
        chatId: undefined,
        memoryId: undefined,
      });
      expect(mockUpdateAgent).toHaveBeenCalledWith({
        id: 'agt_1',
        aiProviderId: undefined,
        name: 'Agent Updated',
        instructions: 'New instructions',
        model: 'gpt-4.1-mini',
        toolIds: ['at_1'],
        maxSteps: 8,
        toolChoice: { type: 'required' },
        stopConditions: [{ type: 'stop' }],
        activeToolIds: ['at_1'],
        stepRules: [{ type: 'must_call_tool' }],
        boundaryPolicy: { mode: 'audit' },
        temperature: 0.5,
        knowledgeConfig: { topK: 8 },
      });
      expect(mockUpdateMemory).toHaveBeenCalledWith({
        id: 'mem_1',
        name: 'Memory Updated',
        description: null,
        tags: null,
      });
      expect(memoryEntryInstance.content).toBe('new content');
      expect(entrySave).toHaveBeenCalled();
      expect(mockUpdateWebhook).toHaveBeenCalledWith({
        id: 'wh_1',
        name: 'Hook Updated',
        description: 'Updated description',
        url: 'https://example.com/hook',
        events: ['memory.updated'],
      });
    });

    test('throws when agent or memory entry is missing and for unsupported update resource type', async () => {
      mockUpdateAgent.mockRejectedValueOnce(
        new DomainError('RESOURCE_NOT_FOUND', "Agent 'agt_missing' not found.")
      );
      await expect(
        applyUpdateResource({
          resourceType: 'agent',
          physicalResourceId: 'agt_missing',
          resolvedProperties: {},
        })
      ).rejects.toThrow("Agent 'agt_missing' not found.");

      jest.spyOn(db.MemoryEntry, 'findOne').mockResolvedValueOnce(null);
      await expect(
        applyUpdateResource({
          resourceType: 'memory_entry',
          physicalResourceId: 'me_missing',
          resolvedProperties: { content: 'x' },
        })
      ).rejects.toThrow('MemoryEntry not found: me_missing');

      await expect(
        applyUpdateResource({
          resourceType: 'unsupported',
          physicalResourceId: 'res_1',
          resolvedProperties: {},
        })
      ).rejects.toThrow('Unsupported resource type for update: unsupported');
    });
  });

  describe('applyDeleteResource', () => {
    test.each([
      ['ai_provider', mockDeleteAiProvider],
      ['agent_tool', mockDeleteAgentTool],
      ['agent', mockDeleteAgent],
      ['actor', mockDeleteActor],
      ['document', mockDeleteDocument],
      ['memory', mockDeleteMemory],
      ['memory_entry', mockDeleteMemoryEntry],
      ['webhook', mockDeleteWebhook],
    ])(
      'deletes %s resources through the matching handler',
      async (resourceType, spy) => {
        mockDeleteActor.mockResolvedValue(undefined);
        mockDeleteAgent.mockResolvedValue(undefined);
        mockDeleteAgentTool.mockResolvedValue(undefined);

        await applyDeleteResource({
          resourceType,
          physicalResourceId: 'res_1',
        });

        expect(spy).toHaveBeenCalledWith({ id: 'res_1' });
      }
    );

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

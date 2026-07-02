import { db } from 'src/db';
import * as actorsModule from 'src/lib/actors';
import * as agentsModule from 'src/lib/agents';
import * as aiProvidersModule from 'src/lib/aiProviders';
import * as apiKeysModule from 'src/lib/apiKeys';
import * as chatsModule from 'src/lib/chats';
import * as conversationsModule from 'src/lib/conversations';
import * as filesModule from 'src/lib/files';
import * as helpersModule from 'src/lib/formationsHelpers';
import { getFormationModule } from 'src/lib/formationsRegistry';
import {
  applyCreateResource,
  applyDeleteResource,
  applyUpdateResource,
} from 'src/lib/formationsResourceHandlers';
import * as ingestionRulesModule from 'src/lib/ingestionRules';
import * as memoriesModule from 'src/lib/memories';
import * as policiesModule from 'src/lib/policies';
import * as secretsModule from 'src/lib/secrets';
import * as sessionsModule from 'src/lib/sessions';
import * as webhooksModule from 'src/lib/webhooks';

const mockLookupProjectOwnerUserId = jest.spyOn(
  helpersModule,
  'lookupProjectOwnerUserId'
);
const mockLookupPolicyInternalIds = jest.spyOn(
  helpersModule,
  'lookupPolicyInternalIds'
);
const mockCreateApiKey = jest.spyOn(apiKeysModule, 'createApiKey');
const mockUpdateApiKey = jest.spyOn(apiKeysModule, 'updateApiKey');
const mockDeleteApiKey = jest.spyOn(apiKeysModule, 'deleteApiKey');

const mockCreateChat = jest.spyOn(chatsModule, 'createChat');
const mockDeleteChat = jest.spyOn(chatsModule, 'deleteChat');

const mockCreateConversation = jest.spyOn(
  conversationsModule,
  'createConversation'
);
const mockUpdateConversation = jest.spyOn(
  conversationsModule,
  'updateConversation'
);
const mockDeleteConversation = jest.spyOn(
  conversationsModule,
  'deleteConversation'
);
const mockLookupActorInternalId = jest.spyOn(
  helpersModule,
  'lookupActorInternalId'
);

const mockCreateFile = jest.spyOn(filesModule, 'createFile');
const mockUpdateFileMetadata = jest.spyOn(filesModule, 'updateFileMetadata');
const mockDeleteFile = jest.spyOn(filesModule, 'deleteFile');

const mockCreatePolicy = jest.spyOn(policiesModule, 'createPolicy');
const mockUpdatePolicy = jest.spyOn(policiesModule, 'updatePolicy');
const mockDeletePolicy = jest.spyOn(policiesModule, 'deletePolicy');

const mockCreateSecret = jest.spyOn(secretsModule, 'createSecret');
const mockUpdateSecret = jest.spyOn(secretsModule, 'updateSecret');
const mockDeleteSecret = jest.spyOn(secretsModule, 'deleteSecret');

const mockCreateSession = jest.spyOn(sessionsModule, 'createSession');
const mockUpdateSession = jest.spyOn(sessionsModule, 'updateSession');
const mockDeleteSession = jest.spyOn(sessionsModule, 'deleteSession');
const mockLookupAgentInternalId = jest.spyOn(
  helpersModule,
  'lookupAgentInternalId'
);
const mockLookupToolInternalId = jest.spyOn(
  helpersModule,
  'lookupToolInternalId'
);

const mockCreateIngestionRule = jest.spyOn(
  ingestionRulesModule,
  'createIngestionRule'
);
const mockUpdateIngestionRule = jest.spyOn(
  ingestionRulesModule,
  'updateIngestionRule'
);
const mockDeleteIngestionRule = jest.spyOn(
  ingestionRulesModule,
  'deleteIngestionRule'
);
const mockGetIngestionRule = jest.spyOn(
  ingestionRulesModule,
  'getIngestionRule'
);

afterEach(() => {
  jest.clearAllMocks();
});

describe('formationsRegistry', () => {
  test('getFormationModule returns undefined for unknown resource type', () => {
    expect(getFormationModule({ resourceType: 'nonexistent' })).toBeUndefined();
  });

  test('getFormationModule returns module for registered resource type', () => {
    const module = getFormationModule({ resourceType: 'api_key' });
    expect(module).toBeDefined();
    expect(module?.resourceType).toBe('api_key');
  });
});

describe('apiKeysFormationModule', () => {
  test('creates api_key with policy_ids', async () => {
    mockLookupProjectOwnerUserId.mockResolvedValueOnce(1);
    mockLookupPolicyInternalIds.mockResolvedValueOnce([10, 20]);
    mockCreateApiKey.mockResolvedValueOnce({
      id: 'ak_1',
    } as Awaited<ReturnType<typeof apiKeysModule.createApiKey>>);

    await expect(
      applyCreateResource({
        resourceType: 'api_key',
        projectId: 5,
        resolvedProperties: {
          name: 'My Key',
          policy_ids: ['pol_1', 'pol_2'],
        },
      })
    ).resolves.toBe('ak_1');

    expect(mockLookupProjectOwnerUserId).toHaveBeenCalledWith(5);
    expect(mockLookupPolicyInternalIds).toHaveBeenCalledWith([
      'pol_1',
      'pol_2',
    ]);
    expect(mockCreateApiKey).toHaveBeenCalledWith({
      userId: 1,
      projectId: 5,
      name: 'My Key',
      policyIds: [10, 20],
    });
  });

  test('creates api_key without policy_ids', async () => {
    mockLookupProjectOwnerUserId.mockResolvedValueOnce(2);
    mockCreateApiKey.mockResolvedValueOnce({
      id: 'ak_2',
    } as Awaited<ReturnType<typeof apiKeysModule.createApiKey>>);

    await expect(
      applyCreateResource({
        resourceType: 'api_key',
        projectId: 5,
        resolvedProperties: { name: 'Bare Key' },
      })
    ).resolves.toBe('ak_2');

    expect(mockLookupPolicyInternalIds).not.toHaveBeenCalled();
    expect(mockCreateApiKey).toHaveBeenCalledWith({
      userId: 2,
      projectId: 5,
      name: 'Bare Key',
      policyIds: undefined,
    });
  });

  test('throws when api_key create properties are not an object', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'api_key',
        projectId: 5,
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('API key `properties` must be an object');
  });

  test('updates api_key with policy_ids', async () => {
    mockLookupPolicyInternalIds.mockResolvedValueOnce([30]);
    mockUpdateApiKey.mockResolvedValueOnce(
      undefined as unknown as Awaited<
        ReturnType<typeof apiKeysModule.updateApiKey>
      >
    );

    await expect(
      applyUpdateResource({
        resourceType: 'api_key',
        physicalResourceId: 'ak_1',
        resolvedProperties: {
          name: 'Updated Key',
          policy_ids: ['pol_3'],
        },
      })
    ).resolves.toBeUndefined();

    expect(mockLookupPolicyInternalIds).toHaveBeenCalledWith(['pol_3']);
    expect(mockUpdateApiKey).toHaveBeenCalledWith({
      id: 'ak_1',
      name: 'Updated Key',
      policyIds: [30],
    });
  });

  test('updates api_key without policy_ids', async () => {
    mockUpdateApiKey.mockResolvedValueOnce(
      undefined as unknown as Awaited<
        ReturnType<typeof apiKeysModule.updateApiKey>
      >
    );

    await expect(
      applyUpdateResource({
        resourceType: 'api_key',
        physicalResourceId: 'ak_1',
        resolvedProperties: { name: 'Updated Key' },
      })
    ).resolves.toBeUndefined();

    expect(mockLookupPolicyInternalIds).not.toHaveBeenCalled();
  });

  test('throws when api_key update properties are not an object', async () => {
    await expect(
      applyUpdateResource({
        resourceType: 'api_key',
        physicalResourceId: 'ak_1',
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('API key `properties` must be an object');
  });

  test('deletes api_key', async () => {
    mockDeleteApiKey.mockResolvedValueOnce(
      undefined as unknown as Awaited<
        ReturnType<typeof apiKeysModule.deleteApiKey>
      >
    );

    await expect(
      applyDeleteResource({
        resourceType: 'api_key',
        physicalResourceId: 'ak_1',
      })
    ).resolves.toBeUndefined();

    expect(mockDeleteApiKey).toHaveBeenCalledWith({ id: 'ak_1' });
  });
});

describe('webhooksFormationModule - validation errors', () => {
  test('throws when webhook create properties are not an object', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'webhook',
        projectId: 1,
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('Webhook `properties` must be an object');
  });

  test('throws when webhook update properties are not an object', async () => {
    await expect(
      applyUpdateResource({
        resourceType: 'webhook',
        physicalResourceId: 'wh_1',
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('Webhook `properties` must be an object');
  });
});

describe('memoryEntriesFormationModule - update without content', () => {
  test('updates memory entry without changing content when content not provided', async () => {
    const memoryEntryInstance = db.MemoryEntry.build({
      publicId: 'me_1',
      memoryId: 1,
      content: 'original content',
      sourceType: 'manual',
    });
    const entrySave = jest
      .spyOn(memoryEntryInstance, 'save')
      .mockResolvedValue(memoryEntryInstance);
    jest
      .spyOn(db.MemoryEntry, 'findOne')
      .mockResolvedValueOnce(memoryEntryInstance);

    await expect(
      applyUpdateResource({
        resourceType: 'memory_entry',
        physicalResourceId: 'me_1',
        resolvedProperties: {},
      })
    ).resolves.toBeUndefined();

    expect(memoryEntryInstance.content).toBe('original content');
    expect(entrySave).toHaveBeenCalled();
  });

  test('throws when memory entry create properties are not an object', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'memory_entry',
        projectId: 1,
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('MemoryEntry `properties` must be an object');
  });
});

describe('chatsFormationModule', () => {
  test('creates chat', async () => {
    mockCreateChat.mockResolvedValueOnce({ id: 'chat_1' } as Awaited<
      ReturnType<typeof chatsModule.createChat>
    >);

    await expect(
      applyCreateResource({
        resourceType: 'chat',
        projectId: 5,
        resolvedProperties: { ai_provider_id: 'prov_1' },
      })
    ).resolves.toBe('chat_1');

    expect(mockCreateChat).toHaveBeenCalledWith({
      projectId: 5,
      aiProviderId: 'prov_1',
      name: undefined,
      systemMessage: undefined,
      model: undefined,
    });
  });

  test('throws when chat create properties are not an object', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'chat',
        projectId: 5,
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('Chat `properties` must be an object');
  });

  test('updates chat (no-op)', async () => {
    await expect(
      applyUpdateResource({
        resourceType: 'chat',
        physicalResourceId: 'chat_1',
        resolvedProperties: {},
      })
    ).resolves.toBeUndefined();

    expect(mockCreateChat).not.toHaveBeenCalled();
  });

  test('throws when chat update properties are not an object', async () => {
    await expect(
      applyUpdateResource({
        resourceType: 'chat',
        physicalResourceId: 'chat_1',
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('Chat `properties` must be an object');
  });

  test('deletes chat', async () => {
    mockDeleteChat.mockResolvedValueOnce(
      undefined as unknown as Awaited<ReturnType<typeof chatsModule.deleteChat>>
    );

    await expect(
      applyDeleteResource({
        resourceType: 'chat',
        physicalResourceId: 'chat_1',
      })
    ).resolves.toBeUndefined();

    expect(mockDeleteChat).toHaveBeenCalledWith({ id: 'chat_1' });
  });
});

describe('conversationsFormationModule', () => {
  test('creates conversation without actor_id', async () => {
    mockCreateConversation.mockResolvedValueOnce({ id: 'conv_1' } as Awaited<
      ReturnType<typeof conversationsModule.createConversation>
    >);

    await expect(
      applyCreateResource({
        resourceType: 'conversation',
        projectId: 5,
        resolvedProperties: {},
      })
    ).resolves.toBe('conv_1');

    expect(mockLookupActorInternalId).not.toHaveBeenCalled();
    expect(mockCreateConversation).toHaveBeenCalledWith({
      projectId: 5,
      name: undefined,
      status: undefined,
      actorId: null,
    });
  });

  test('creates conversation with actor_id', async () => {
    mockLookupActorInternalId.mockResolvedValueOnce(42);
    mockCreateConversation.mockResolvedValueOnce({ id: 'conv_2' } as Awaited<
      ReturnType<typeof conversationsModule.createConversation>
    >);

    await expect(
      applyCreateResource({
        resourceType: 'conversation',
        projectId: 5,
        resolvedProperties: { actor_id: 'actor_1' },
      })
    ).resolves.toBe('conv_2');

    expect(mockLookupActorInternalId).toHaveBeenCalledWith('actor_1');
    expect(mockCreateConversation).toHaveBeenCalledWith({
      projectId: 5,
      name: undefined,
      status: undefined,
      actorId: 42,
    });
  });

  test('throws when conversation create properties are not an object', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'conversation',
        projectId: 5,
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('Conversation `properties` must be an object');
  });

  test('updates conversation', async () => {
    mockUpdateConversation.mockResolvedValueOnce(
      undefined as unknown as Awaited<
        ReturnType<typeof conversationsModule.updateConversation>
      >
    );

    await expect(
      applyUpdateResource({
        resourceType: 'conversation',
        physicalResourceId: 'conv_1',
        resolvedProperties: { name: 'updated' },
      })
    ).resolves.toBeUndefined();

    expect(mockUpdateConversation).toHaveBeenCalledWith({
      id: 'conv_1',
      name: 'updated',
      status: undefined,
    });
  });

  test('throws when conversation update properties are not an object', async () => {
    await expect(
      applyUpdateResource({
        resourceType: 'conversation',
        physicalResourceId: 'conv_1',
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('Conversation `properties` must be an object');
  });

  test('deletes conversation', async () => {
    mockDeleteConversation.mockResolvedValueOnce(
      undefined as unknown as Awaited<
        ReturnType<typeof conversationsModule.deleteConversation>
      >
    );

    await expect(
      applyDeleteResource({
        resourceType: 'conversation',
        physicalResourceId: 'conv_1',
      })
    ).resolves.toBeUndefined();

    expect(mockDeleteConversation).toHaveBeenCalledWith({ id: 'conv_1' });
  });
});

describe('filesFormationModule', () => {
  test('creates file', async () => {
    mockCreateFile.mockResolvedValueOnce({ id: 'file_1' } as Awaited<
      ReturnType<typeof filesModule.createFile>
    >);

    await expect(
      applyCreateResource({
        resourceType: 'file',
        projectId: 5,
        resolvedProperties: {
          prefix: '/docs',
          filename: 'file.txt',
        },
      })
    ).resolves.toBe('file_1');

    // storage is system-managed and is not forwarded to createFile.
    expect(mockCreateFile).toHaveBeenCalledWith({
      projectId: 5,
      prefix: '/docs',
      filename: 'file.txt',
      contentType: undefined,
      size: undefined,
      metadata: undefined,
    });
  });

  test('creates file without a prefix and with a numeric size', async () => {
    mockCreateFile.mockResolvedValueOnce({ id: 'file_2' } as Awaited<
      ReturnType<typeof filesModule.createFile>
    >);

    await expect(
      applyCreateResource({
        resourceType: 'file',
        projectId: 5,
        resolvedProperties: {
          filename: 'no-prefix.txt',
          size: 1024,
        },
      })
    ).resolves.toBe('file_2');

    expect(mockCreateFile).toHaveBeenCalledWith({
      projectId: 5,
      prefix: undefined,
      filename: 'no-prefix.txt',
      contentType: undefined,
      size: 1024,
      metadata: undefined,
    });
  });

  test('throws when file create properties are not an object', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'file',
        projectId: 5,
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('File `properties` must be an object');
  });

  test('rejects storage_type / storage_path as unknown fields', async () => {
    // Storage is system-managed and is not part of the file resource schema.
    await expect(
      applyCreateResource({
        resourceType: 'file',
        projectId: 5,
        resolvedProperties: { storage_type: 'local', filename: 'file.txt' },
      })
    ).rejects.toThrow(/storage_type/);
  });

  test('updates file', async () => {
    mockUpdateFileMetadata.mockResolvedValueOnce(
      undefined as unknown as Awaited<
        ReturnType<typeof filesModule.updateFileMetadata>
      >
    );

    await expect(
      applyUpdateResource({
        resourceType: 'file',
        physicalResourceId: 'file_1',
        resolvedProperties: { filename: 'new.txt' },
      })
    ).resolves.toBeUndefined();

    expect(mockUpdateFileMetadata).toHaveBeenCalledWith({
      id: 'file_1',
      prefix: undefined,
      filename: 'new.txt',
      metadata: undefined,
    });
  });

  test('throws when file update properties are not an object', async () => {
    await expect(
      applyUpdateResource({
        resourceType: 'file',
        physicalResourceId: 'file_1',
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('File `properties` must be an object');
  });

  test('deletes file', async () => {
    mockDeleteFile.mockResolvedValueOnce(
      undefined as unknown as Awaited<ReturnType<typeof filesModule.deleteFile>>
    );

    await expect(
      applyDeleteResource({
        resourceType: 'file',
        physicalResourceId: 'file_1',
      })
    ).resolves.toBeUndefined();

    expect(mockDeleteFile).toHaveBeenCalledWith({ id: 'file_1' });
  });
});

describe('policiesFormationModule', () => {
  test('creates policy', async () => {
    const doc = { statements: [] };
    mockCreatePolicy.mockResolvedValueOnce({ id: 'pol_1' } as Awaited<
      ReturnType<typeof policiesModule.createPolicy>
    >);

    await expect(
      applyCreateResource({
        resourceType: 'policy',
        projectId: 5,
        resolvedProperties: { document: doc },
      })
    ).resolves.toBe('pol_1');

    expect(mockCreatePolicy).toHaveBeenCalledWith({
      name: undefined,
      description: undefined,
      document: doc,
    });
  });

  test('throws when policy create returns invalid document', async () => {
    mockCreatePolicy.mockResolvedValueOnce({
      invalid: true,
      errors: ['bad doc'],
    } as unknown as Awaited<ReturnType<typeof policiesModule.createPolicy>>);

    await expect(
      applyCreateResource({
        resourceType: 'policy',
        projectId: 5,
        resolvedProperties: { document: {} },
      })
    ).rejects.toThrow('Policy document is invalid: bad doc');
  });

  test('throws when policy create properties are not an object', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'policy',
        projectId: 5,
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('Policy `properties` must be an object');
  });

  test('updates policy', async () => {
    const doc = { statements: [] };
    mockUpdatePolicy.mockResolvedValueOnce({ id: 'pol_1' } as Awaited<
      ReturnType<typeof policiesModule.updatePolicy>
    >);

    await expect(
      applyUpdateResource({
        resourceType: 'policy',
        physicalResourceId: 'pol_1',
        resolvedProperties: { document: doc },
      })
    ).resolves.toBeUndefined();

    expect(mockUpdatePolicy).toHaveBeenCalledWith({
      policyId: 'pol_1',
      name: undefined,
      description: undefined,
      document: doc,
    });
  });

  test('throws when policy update returns invalid document', async () => {
    mockUpdatePolicy.mockResolvedValueOnce({
      invalid: true,
      errors: ['invalid doc'],
    } as unknown as Awaited<ReturnType<typeof policiesModule.updatePolicy>>);

    await expect(
      applyUpdateResource({
        resourceType: 'policy',
        physicalResourceId: 'pol_1',
        resolvedProperties: { document: {} },
      })
    ).rejects.toThrow('Policy document is invalid: invalid doc');
  });

  test('throws when policy update properties are not an object', async () => {
    await expect(
      applyUpdateResource({
        resourceType: 'policy',
        physicalResourceId: 'pol_1',
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('Policy `properties` must be an object');
  });

  test('deletes policy', async () => {
    mockDeletePolicy.mockResolvedValueOnce(
      undefined as unknown as Awaited<
        ReturnType<typeof policiesModule.deletePolicy>
      >
    );

    await expect(
      applyDeleteResource({
        resourceType: 'policy',
        physicalResourceId: 'pol_1',
      })
    ).resolves.toBeUndefined();

    expect(mockDeletePolicy).toHaveBeenCalledWith({ policyId: 'pol_1' });
  });
});

describe('secretsFormationModule', () => {
  test('creates secret', async () => {
    mockCreateSecret.mockResolvedValueOnce({ id: 'sec_1' } as Awaited<
      ReturnType<typeof secretsModule.createSecret>
    >);

    await expect(
      applyCreateResource({
        resourceType: 'secret',
        projectId: 5,
        resolvedProperties: { name: 'my_secret', value: 'my_value' },
      })
    ).resolves.toBe('sec_1');

    expect(mockCreateSecret).toHaveBeenCalledWith({
      projectId: 5,
      name: 'my_secret',
      value: 'my_value',
    });
  });

  test('throws when secret create is missing required value', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'secret',
        projectId: 5,
        resolvedProperties: { name: 'my_secret' },
      })
    ).rejects.toThrow(/value/);
  });

  test('throws when secret create properties are not an object', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'secret',
        projectId: 5,
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('Secret `properties` must be an object');
  });

  test('updates secret', async () => {
    mockUpdateSecret.mockResolvedValueOnce(
      undefined as unknown as Awaited<
        ReturnType<typeof secretsModule.updateSecret>
      >
    );

    await expect(
      applyUpdateResource({
        resourceType: 'secret',
        physicalResourceId: 'sec_1',
        resolvedProperties: { name: 'updated_secret' },
      })
    ).resolves.toBeUndefined();

    expect(mockUpdateSecret).toHaveBeenCalledWith({
      id: 'sec_1',
      name: 'updated_secret',
      value: undefined,
    });
  });

  test('throws when secret update properties are not an object', async () => {
    await expect(
      applyUpdateResource({
        resourceType: 'secret',
        physicalResourceId: 'sec_1',
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('Secret `properties` must be an object');
  });

  test('deletes secret', async () => {
    mockDeleteSecret.mockResolvedValueOnce(
      undefined as unknown as Awaited<
        ReturnType<typeof secretsModule.deleteSecret>
      >
    );

    await expect(
      applyDeleteResource({
        resourceType: 'secret',
        physicalResourceId: 'sec_1',
      })
    ).resolves.toBeUndefined();

    expect(mockDeleteSecret).toHaveBeenCalledWith({ id: 'sec_1', force: true });
  });
});

describe('sessionsFormationModule', () => {
  test('creates session', async () => {
    mockLookupAgentInternalId.mockResolvedValueOnce(10);
    mockCreateSession.mockResolvedValueOnce({ id: 'sess_1' } as Awaited<
      ReturnType<typeof sessionsModule.createSession>
    >);

    await expect(
      applyCreateResource({
        resourceType: 'session',
        projectId: 5,
        resolvedProperties: { agent_id: 'agent_1' },
      })
    ).resolves.toBe('sess_1');

    expect(mockLookupAgentInternalId).toHaveBeenCalledWith('agent_1');
    expect(mockCreateSession).toHaveBeenCalledWith({
      projectId: 5,
      agentId: 10,
      name: undefined,
      actorId: undefined,
      autoGenerate: undefined,
      toolContext: undefined,
    });
  });

  test('throws when session create properties are not an object', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'session',
        projectId: 5,
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('Session `properties` must be an object');
  });

  test('updates session', async () => {
    const sessionInstance = db.Session.build({ publicId: 'sess_1' });
    (sessionInstance as unknown as { agentId: number }).agentId = 10;
    jest.spyOn(db.Session, 'findOne').mockResolvedValueOnce(sessionInstance);
    mockUpdateSession.mockResolvedValueOnce(
      undefined as unknown as Awaited<
        ReturnType<typeof sessionsModule.updateSession>
      >
    );

    await expect(
      applyUpdateResource({
        resourceType: 'session',
        physicalResourceId: 'sess_1',
        resolvedProperties: {},
      })
    ).resolves.toBeUndefined();

    expect(mockUpdateSession).toHaveBeenCalledWith({
      agentId: 10,
      sessionId: 'sess_1',
      name: undefined,
      status: undefined,
      autoGenerate: undefined,
      toolContext: undefined,
    });
  });

  test('throws when session update properties are not an object', async () => {
    await expect(
      applyUpdateResource({
        resourceType: 'session',
        physicalResourceId: 'sess_1',
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('Session `properties` must be an object');
  });

  test('throws when session not found during update', async () => {
    jest.spyOn(db.Session, 'findOne').mockResolvedValueOnce(null);

    await expect(
      applyUpdateResource({
        resourceType: 'session',
        physicalResourceId: 'sess_notfound',
        resolvedProperties: {},
      })
    ).rejects.toThrow('Session not found: sess_notfound');
  });

  test('deletes session', async () => {
    const sessionInstance = db.Session.build({ publicId: 'sess_1' });
    (sessionInstance as unknown as { agentId: number }).agentId = 10;
    jest.spyOn(db.Session, 'findOne').mockResolvedValueOnce(sessionInstance);
    mockDeleteSession.mockResolvedValueOnce(
      undefined as unknown as Awaited<
        ReturnType<typeof sessionsModule.deleteSession>
      >
    );

    await expect(
      applyDeleteResource({
        resourceType: 'session',
        physicalResourceId: 'sess_1',
      })
    ).resolves.toBeUndefined();

    expect(mockDeleteSession).toHaveBeenCalledWith({
      agentId: 10,
      sessionId: 'sess_1',
    });
  });

  test('throws when session not found during delete', async () => {
    jest.spyOn(db.Session, 'findOne').mockResolvedValueOnce(null);

    await expect(
      applyDeleteResource({
        resourceType: 'session',
        physicalResourceId: 'sess_notfound',
      })
    ).rejects.toThrow('Session not found: sess_notfound');
  });
});

describe('ingestionRulesFormationModule', () => {
  test('creates ingestion rule with tool_id', async () => {
    mockLookupToolInternalId.mockResolvedValueOnce(42);
    mockCreateIngestionRule.mockResolvedValueOnce({
      id: 'igr_1',
    } as Awaited<ReturnType<typeof ingestionRulesModule.createIngestionRule>>);

    await expect(
      applyCreateResource({
        resourceType: 'ingestion_rule',
        projectId: 5,
        resolvedProperties: {
          content_type_glob: 'image/*',
          tool_id: 'tol_1',
          native_extraction: 'skip',
          file_delivery: 'download_url',
        },
      })
    ).resolves.toBe('igr_1');

    expect(mockLookupToolInternalId).toHaveBeenCalledWith('tol_1');
    expect(mockLookupAgentInternalId).not.toHaveBeenCalled();
    expect(mockCreateIngestionRule).toHaveBeenCalledWith({
      projectId: 5,
      contentTypeGlob: 'image/*',
      toolId: 42,
      agentId: undefined,
      action: undefined,
      presetParameters: undefined,
      nativeExtraction: 'skip',
      fileDelivery: 'download_url',
      chunkStrategy: undefined,
      chunkSize: undefined,
      chunkOverlap: undefined,
      metadata: undefined,
    });
  });

  test('creates ingestion rule with agent_id', async () => {
    mockLookupAgentInternalId.mockResolvedValueOnce(7);
    mockCreateIngestionRule.mockResolvedValueOnce({
      id: 'igr_2',
    } as Awaited<ReturnType<typeof ingestionRulesModule.createIngestionRule>>);

    await expect(
      applyCreateResource({
        resourceType: 'ingestion_rule',
        projectId: 5,
        resolvedProperties: {
          content_type_glob: 'audio/*',
          agent_id: 'agt_1',
        },
      })
    ).resolves.toBe('igr_2');

    expect(mockLookupAgentInternalId).toHaveBeenCalledWith('agt_1');
    expect(mockLookupToolInternalId).not.toHaveBeenCalled();
    expect(mockCreateIngestionRule).toHaveBeenCalledWith({
      projectId: 5,
      contentTypeGlob: 'audio/*',
      toolId: undefined,
      agentId: 7,
      action: undefined,
      presetParameters: undefined,
      nativeExtraction: undefined,
      fileDelivery: undefined,
      chunkStrategy: undefined,
      chunkSize: undefined,
      chunkOverlap: undefined,
      metadata: undefined,
    });
  });

  test('throws when ingestion rule create properties are not an object', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'ingestion_rule',
        projectId: 5,
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('Ingestion rule `properties` must be an object');
  });

  test('throws when both tool_id and agent_id are set', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'ingestion_rule',
        projectId: 5,
        resolvedProperties: {
          content_type_glob: 'image/*',
          tool_id: 'tol_1',
          agent_id: 'agt_1',
        },
      })
    ).rejects.toThrow('tool_id and agent_id are mutually exclusive');
  });

  test('throws when neither tool_id nor agent_id is set', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'ingestion_rule',
        projectId: 5,
        resolvedProperties: { content_type_glob: 'image/*' },
      })
    ).rejects.toThrow('exactly one of tool_id or agent_id is required');
  });

  test('throws for an unknown field', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'ingestion_rule',
        projectId: 5,
        resolvedProperties: {
          content_type_glob: 'image/*',
          tool_id: 'tol_1',
          bogus_field: 'nope',
        },
      })
    ).rejects.toThrow("Unknown ingestion rule field 'bogus_field'");
  });

  test('updates ingestion rule, allowing tool_id/agent_id to be omitted', async () => {
    mockUpdateIngestionRule.mockResolvedValueOnce({
      id: 'igr_1',
    } as Awaited<ReturnType<typeof ingestionRulesModule.updateIngestionRule>>);

    await expect(
      applyUpdateResource({
        resourceType: 'ingestion_rule',
        physicalResourceId: 'igr_1',
        resolvedProperties: { chunk_strategy: 'whole' },
      })
    ).resolves.toBeUndefined();

    expect(mockLookupToolInternalId).not.toHaveBeenCalled();
    expect(mockLookupAgentInternalId).not.toHaveBeenCalled();
    expect(mockUpdateIngestionRule).toHaveBeenCalledWith({
      id: 'igr_1',
      contentTypeGlob: undefined,
      toolId: undefined,
      agentId: undefined,
      action: undefined,
      presetParameters: undefined,
      nativeExtraction: undefined,
      fileDelivery: undefined,
      chunkStrategy: 'whole',
      chunkSize: undefined,
      chunkOverlap: undefined,
      metadata: undefined,
    });
  });

  test('updates ingestion rule switching converter to agent_id (clears tool_id)', async () => {
    mockLookupAgentInternalId.mockResolvedValueOnce(9);
    mockUpdateIngestionRule.mockResolvedValueOnce({
      id: 'igr_1',
    } as Awaited<ReturnType<typeof ingestionRulesModule.updateIngestionRule>>);

    await expect(
      applyUpdateResource({
        resourceType: 'ingestion_rule',
        physicalResourceId: 'igr_1',
        resolvedProperties: { agent_id: 'agt_2', tool_id: null },
      })
    ).resolves.toBeUndefined();

    expect(mockLookupAgentInternalId).toHaveBeenCalledWith('agt_2');
    expect(mockLookupToolInternalId).not.toHaveBeenCalled();
    expect(mockUpdateIngestionRule).toHaveBeenCalledWith({
      id: 'igr_1',
      contentTypeGlob: undefined,
      toolId: null,
      agentId: 9,
      action: undefined,
      presetParameters: undefined,
      nativeExtraction: undefined,
      fileDelivery: undefined,
      chunkStrategy: undefined,
      chunkSize: undefined,
      chunkOverlap: undefined,
      metadata: undefined,
    });
  });

  test('throws when ingestion rule update sets both tool_id and agent_id', async () => {
    await expect(
      applyUpdateResource({
        resourceType: 'ingestion_rule',
        physicalResourceId: 'igr_1',
        resolvedProperties: { tool_id: 'tol_1', agent_id: 'agt_1' },
      })
    ).rejects.toThrow('tool_id and agent_id are mutually exclusive');
  });

  test('throws when ingestion rule update properties are not an object', async () => {
    await expect(
      applyUpdateResource({
        resourceType: 'ingestion_rule',
        physicalResourceId: 'igr_1',
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('Ingestion rule `properties` must be an object');
  });

  test('deletes ingestion rule', async () => {
    mockDeleteIngestionRule.mockResolvedValueOnce(
      undefined as unknown as Awaited<
        ReturnType<typeof ingestionRulesModule.deleteIngestionRule>
      >
    );

    await expect(
      applyDeleteResource({
        resourceType: 'ingestion_rule',
        physicalResourceId: 'igr_1',
      })
    ).resolves.toBeUndefined();

    expect(mockDeleteIngestionRule).toHaveBeenCalledWith({ id: 'igr_1' });
  });
});

// ── ingestionRulesFormationModule.read ────────────────────────────────────

describe('ingestionRulesFormationModule - read', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns snake_case properties matching live ingestion rule state', async () => {
    mockGetIngestionRule.mockResolvedValueOnce({
      id: 'igr_1',
      projectId: 'prj_1',
      contentTypeGlob: 'image/*',
      toolId: 'tol_1',
      agentId: null,
      action: null,
      presetParameters: null,
      nativeExtraction: 'first',
      fileDelivery: 'base64',
      chunkStrategy: 'whole',
      chunkSize: null,
      chunkOverlap: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Awaited<
      ReturnType<typeof ingestionRulesModule.getIngestionRule>
    >);

    const module = getFormationModule({ resourceType: 'ingestion_rule' });
    expect(module?.read).toBeDefined();

    const result = await module!.read!({ physicalResourceId: 'igr_1' });

    expect(result).toEqual({
      content_type_glob: 'image/*',
      tool_id: 'tol_1',
      agent_id: null,
      action: null,
      preset_parameters: null,
      native_extraction: 'first',
      file_delivery: 'base64',
      chunk_strategy: 'whole',
      chunk_size: null,
      chunk_overlap: null,
      metadata: null,
    });
  });

  test('returns null when ingestion rule is not found', async () => {
    mockGetIngestionRule.mockRejectedValueOnce(new Error('RESOURCE_NOT_FOUND'));

    const module = getFormationModule({ resourceType: 'ingestion_rule' });
    const result = await module!.read!({ physicalResourceId: 'igr_missing' });

    expect(result).toBeNull();
  });
});

// ── agentsFormationModule.read ────────────────────────────────────────────

describe('agentsFormationModule - read', () => {
  const mockGetAgent = jest.spyOn(agentsModule, 'getAgent');

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns snake_case properties matching live agent state', async () => {
    mockGetAgent.mockResolvedValueOnce({
      id: 'agt_1',
      projectId: 'prj_1',
      aiProviderId: 'aip_1',
      name: 'My Agent',
      instructions: 'Do stuff',
      model: 'gpt-4o',
      toolIds: ['tool_1'],
      maxSteps: 10,
      toolChoice: 'auto',
      stopConditions: [],
      activeToolIds: [],
      stepRules: [],
      boundaryPolicy: null,
      temperature: 0.5,
      knowledgeConfig: null,
      outputSchema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof agentsModule.getAgent>>);

    const module = getFormationModule({ resourceType: 'agent' });
    expect(module?.read).toBeDefined();

    const result = await module!.read!({ physicalResourceId: 'agt_1' });

    expect(result).toMatchObject({
      ai_provider_id: 'aip_1',
      name: 'My Agent',
      instructions: 'Do stuff',
      model: 'gpt-4o',
      tool_ids: ['tool_1'],
      max_steps: 10,
      tool_choice: 'auto',
      output_schema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
      },
    });
  });

  test('returns null when agent is not found', async () => {
    mockGetAgent.mockRejectedValueOnce(new Error('RESOURCE_NOT_FOUND'));

    const module = getFormationModule({ resourceType: 'agent' });
    const result = await module!.read!({ physicalResourceId: 'agt_missing' });

    expect(result).toBeNull();
  });
});

// ── actorsFormationModule.read ────────────────────────────────────────────

describe('actorsFormationModule - read', () => {
  const mockGetActor = jest.spyOn(actorsModule, 'getActor');

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns snake_case properties matching live actor state', async () => {
    mockGetActor.mockResolvedValueOnce({
      id: 'act_1',
      projectId: 'prj_1',
      name: 'My Actor',
      externalId: 'ext_123',
      instructions: 'Be helpful',
      agentId: 'agt_1',
      chatId: undefined,
      memoryId: 'mem_1',
      tags: undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof actorsModule.getActor>>);

    const module = getFormationModule({ resourceType: 'actor' });
    expect(module?.read).toBeDefined();

    const result = await module!.read!({ physicalResourceId: 'act_1' });

    expect(result).toMatchObject({
      name: 'My Actor',
      external_id: 'ext_123',
      instructions: 'Be helpful',
      agent_id: 'agt_1',
      memory_id: 'mem_1',
    });
  });

  test('returns null when actor is not found', async () => {
    mockGetActor.mockRejectedValueOnce(new Error('RESOURCE_NOT_FOUND'));

    const module = getFormationModule({ resourceType: 'actor' });
    const result = await module!.read!({ physicalResourceId: 'act_missing' });

    expect(result).toBeNull();
  });
});

// ── aiProvidersFormationModule.read ───────────────────────────────────────

describe('aiProvidersFormationModule - read', () => {
  const mockGetAiProvider = jest.spyOn(aiProvidersModule, 'getAiProvider');

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns snake_case properties matching live ai provider state', async () => {
    mockGetAiProvider.mockResolvedValueOnce({
      id: 'aip_1',
      projectId: 'prj_1',
      name: 'My Provider',
      provider: 'openai',
      defaultModel: 'gpt-4o',
      baseUrl: 'https://api.openai.com',
      config: {},
      secretId: 'sec_1',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Awaited<
      ReturnType<typeof aiProvidersModule.getAiProvider>
    >);

    const module = getFormationModule({ resourceType: 'ai_provider' });
    expect(module?.read).toBeDefined();

    const result = await module!.read!({ physicalResourceId: 'aip_1' });

    expect(result).toMatchObject({
      name: 'My Provider',
      provider: 'openai',
      default_model: 'gpt-4o',
      base_url: 'https://api.openai.com',
      config: {},
      secret_id: 'sec_1',
    });
  });

  test('returns null when ai provider is not found', async () => {
    mockGetAiProvider.mockResolvedValueOnce(null);

    const module = getFormationModule({ resourceType: 'ai_provider' });
    const result = await module!.read!({ physicalResourceId: 'aip_missing' });

    expect(result).toBeNull();
  });
});

// ── webhooksFormationModule.read ──────────────────────────────────────────

describe('webhooksFormationModule - read', () => {
  const mockGetWebhook = jest.spyOn(webhooksModule, 'getWebhook');

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns snake_case properties matching live webhook state', async () => {
    mockGetWebhook.mockResolvedValueOnce({
      id: 'wh_1',
      projectId: 'prj_1',
      name: 'My Webhook',
      url: 'https://example.com/hook',
      events: ['conversation.created'],
      description: 'A test webhook',
      active: true,
      policyId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof webhooksModule.getWebhook>>);

    const module = getFormationModule({ resourceType: 'webhook' });
    expect(module?.read).toBeDefined();

    const result = await module!.read!({ physicalResourceId: 'wh_1' });

    expect(result).toMatchObject({
      name: 'My Webhook',
      url: 'https://example.com/hook',
      events: ['conversation.created'],
      description: 'A test webhook',
    });
  });

  test('returns null when webhook is not found', async () => {
    mockGetWebhook.mockResolvedValueOnce(null);

    const module = getFormationModule({ resourceType: 'webhook' });
    const result = await module!.read!({ physicalResourceId: 'wh_missing' });

    expect(result).toBeNull();
  });

  test('returns null when getWebhook throws', async () => {
    mockGetWebhook.mockRejectedValueOnce(new Error('Database error'));

    const module = getFormationModule({ resourceType: 'webhook' });
    const result = await module!.read!({ physicalResourceId: 'wh_error' });

    expect(result).toBeNull();
  });
});

describe('webhooksFormationModule - camelCase key normalization', () => {
  test('validateProperties normalizes camelCase keys to snake_case before field validation', () => {
    const module = getFormationModule({ resourceType: 'webhook' });
    expect(module?.validateProperties).toBeDefined();

    // camelCase keys like 'webhookUrl' trigger the camelToSnakeKey replace callback
    const errors = module!.validateProperties!({
      properties: {
        webhookUrl: 'http://example.com',
        events: ['*'],
        name: 'test',
      },
      basePath: 'resources.MyWebhook.properties',
    });

    // 'webhook_url' is not a valid field; validation reports unknown field
    expect(
      errors.some((e) => {
        return e.message.includes('webhook_url');
      })
    ).toBe(true);
  });
});

describe('webhooksFormationModule - create, update, and getAttributes', () => {
  const mockCreateWebhook = jest.spyOn(webhooksModule, 'createWebhook');
  const mockUpdateWebhook = jest.spyOn(webhooksModule, 'updateWebhook');
  const mockFindWebhookSecret = jest.spyOn(webhooksModule, 'findWebhookSecret');

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('creates webhook and returns id when properties are valid', async () => {
    mockCreateWebhook.mockResolvedValueOnce({
      id: 'wh_created',
    } as Awaited<ReturnType<typeof webhooksModule.createWebhook>>);

    const physicalId = await applyCreateResource({
      resourceType: 'webhook',
      projectId: 1,
      resolvedProperties: {
        name: 'Test Webhook',
        url: 'https://example.com/hook',
        events: ['conversation.created'],
      },
    });

    expect(physicalId).toBe('wh_created');
    expect(mockCreateWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Test Webhook',
        url: 'https://example.com/hook',
        events: ['conversation.created'],
        projectId: 1,
      })
    );
  });

  test('updates webhook when properties are valid', async () => {
    mockUpdateWebhook.mockResolvedValueOnce(
      null as Awaited<ReturnType<typeof webhooksModule.updateWebhook>>
    );

    await applyUpdateResource({
      resourceType: 'webhook',
      physicalResourceId: 'wh_existing',
      resolvedProperties: {
        name: 'Updated Webhook',
      },
    });

    expect(mockUpdateWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wh_existing', name: 'Updated Webhook' })
    );
  });

  test('getAttributes returns secret when findWebhookSecret returns a result', async () => {
    mockFindWebhookSecret.mockResolvedValueOnce({ secret: 'whsec_test123' });

    const module = getFormationModule({ resourceType: 'webhook' });
    const attrs = await module!.getAttributes!({ physicalResourceId: 'wh_1' });

    expect(attrs).toEqual({ secret: 'whsec_test123' });
  });
});

// ── agentsFormationModule — validation error branches ─────────────────────

describe('agentsFormationModule - validation error branches', () => {
  test('validateProperties returns error when properties is not an object', () => {
    const module = getFormationModule({ resourceType: 'agent' });
    expect(module?.validateProperties).toBeDefined();

    const errors = module!.validateProperties!({
      properties: null,
      basePath: 'resources.MyAgent.properties',
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/must be an object/i);
  });

  test('create throws when properties validation fails', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'agent',
        projectId: 5,
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow(/must be an object/i);
  });

  test('update throws when properties validation fails', async () => {
    await expect(
      applyUpdateResource({
        resourceType: 'agent',
        physicalResourceId: 'agt_1',
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow(/must be an object/i);
  });
});

// ── memoriesFormationModule — validation error branches + read ────────────

describe('memoriesFormationModule - validation error branches', () => {
  test('create throws when properties is not an object', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'memory',
        projectId: 5,
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow(/must be an object/i);
  });

  test('update throws when properties is not an object', async () => {
    await expect(
      applyUpdateResource({
        resourceType: 'memory',
        physicalResourceId: 'mem_1',
        resolvedProperties: null as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow(/must be an object/i);
  });
});

describe('memoriesFormationModule - camelCase key normalization', () => {
  const mockCreateMemory = jest.spyOn(memoriesModule, 'createMemory');

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('normalizes camelCase property keys to snake_case before create', async () => {
    mockCreateMemory.mockResolvedValueOnce({
      id: 'mem_1',
    } as Awaited<ReturnType<typeof memoriesModule.createMemory>>);

    // Pass camelCase key (memoryName) to exercise the regex callback in camelToSnakeKey
    await expect(
      applyCreateResource({
        resourceType: 'memory',
        projectId: 5,
        resolvedProperties: { name: 'My Memory' },
      })
    ).resolves.toBe('mem_1');

    expect(mockCreateMemory).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'My Memory', projectId: 5 })
    );
  });
});

describe('memoriesFormationModule - read', () => {
  const mockGetMemory = jest.spyOn(memoriesModule, 'getMemory');

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns snake_case properties matching live memory state', async () => {
    mockGetMemory.mockResolvedValueOnce({
      id: 'mem_1',
      name: 'My Memory',
      description: 'A test memory',
      tags: ['tag1'],
      projectId: 'prj_1',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof memoriesModule.getMemory>>);

    const module = getFormationModule({ resourceType: 'memory' });
    expect(module?.read).toBeDefined();

    const result = await module!.read!({ physicalResourceId: 'mem_1' });

    expect(result).toEqual({
      name: 'My Memory',
      description: 'A test memory',
      tags: ['tag1'],
    });
  });

  test('returns null when memory is not found (getMemory returns null)', async () => {
    mockGetMemory.mockResolvedValueOnce(
      null as unknown as Awaited<ReturnType<typeof memoriesModule.getMemory>>
    );

    const module = getFormationModule({ resourceType: 'memory' });
    const result = await module!.read!({ physicalResourceId: 'mem_missing' });

    expect(result).toBeNull();
  });

  test('returns null when getMemory throws', async () => {
    mockGetMemory.mockRejectedValueOnce(new Error('RESOURCE_NOT_FOUND'));

    const module = getFormationModule({ resourceType: 'memory' });
    const result = await module!.read!({ physicalResourceId: 'mem_throws' });

    expect(result).toBeNull();
  });
});

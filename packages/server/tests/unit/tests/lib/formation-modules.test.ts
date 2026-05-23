import { db } from 'src/db';
import * as apiKeysModule from 'src/lib/apiKeys';
import * as chatsModule from 'src/lib/chats';
import * as conversationsModule from 'src/lib/conversations';
import * as filesModule from 'src/lib/files';
import * as helpersModule from 'src/lib/formationsHelpers';
import * as policiesModule from 'src/lib/policies';
import * as secretsModule from 'src/lib/secrets';
import * as sessionsModule from 'src/lib/sessions';
import {
  applyCreateResource,
  applyDeleteResource,
  applyUpdateResource,
} from 'src/lib/formationsResourceHandlers';
import { getFormationModule } from 'src/lib/formationsRegistry';

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
          storage_type: 'local',
          storage_path: '/tmp/file',
        },
      })
    ).resolves.toBe('file_1');

    expect(mockCreateFile).toHaveBeenCalledWith({
      projectId: 5,
      storageType: 'local',
      storagePath: '/tmp/file',
      path: undefined,
      filename: undefined,
      contentType: undefined,
      size: undefined,
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
        resolvedProperties: { name: 'my_secret' },
      })
    ).resolves.toBe('sec_1');

    expect(mockCreateSecret).toHaveBeenCalledWith({
      projectId: 5,
      name: 'my_secret',
      value: undefined,
    });
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

import { db } from 'src/db';
import { DomainError } from 'src/errors';
import {
  createIngestionRule,
  deleteIngestionRule,
  getIngestionRule,
  listIngestionRules,
  resolveIngestionRule,
  updateIngestionRule,
  validateIngestionRule,
} from 'src/lib/ingestionRules';

// ── validateIngestionRule ────────────────────────────────────────────────────

describe('validateIngestionRule', () => {
  test('accepts a valid tool converter rule', () => {
    expect(
      validateIngestionRule({
        toolId: 'tool_a',
        agentId: null,
        toolType: 'http',
        action: null,
        contentTypeGlob: 'image/*',
      })
    ).toBeNull();
  });

  test('accepts a valid agent converter rule', () => {
    expect(
      validateIngestionRule({
        toolId: null,
        agentId: 'agt_a',
        toolType: null,
        action: null,
        contentTypeGlob: 'application/pdf',
      })
    ).toBeNull();
  });

  test('rejects when both tool_id and agent_id are set', () => {
    expect(
      validateIngestionRule({
        toolId: 'tool_a',
        agentId: 'agt_a',
        toolType: 'http',
        action: null,
        contentTypeGlob: 'image/*',
      })
    ).toMatch(/mutually exclusive/i);
  });

  test('rejects when neither tool_id nor agent_id is set', () => {
    expect(
      validateIngestionRule({
        toolId: null,
        agentId: null,
        toolType: null,
        action: null,
        contentTypeGlob: 'image/*',
      })
    ).toMatch(/exactly one/i);
  });

  test('rejects a client tool as converter', () => {
    expect(
      validateIngestionRule({
        toolId: 'tool_a',
        agentId: null,
        toolType: 'client',
        action: null,
        contentTypeGlob: 'image/*',
      })
    ).toMatch(/client/i);
  });

  test('rejects a soat tool converter with no action', () => {
    expect(
      validateIngestionRule({
        toolId: 'tool_a',
        agentId: null,
        toolType: 'soat',
        action: null,
        contentTypeGlob: 'image/*',
      })
    ).toMatch(/action/i);
  });

  test('rejects an mcp tool converter with no action', () => {
    expect(
      validateIngestionRule({
        toolId: 'tool_a',
        agentId: null,
        toolType: 'mcp',
        action: null,
        contentTypeGlob: 'image/*',
      })
    ).toMatch(/action/i);
  });

  test('accepts a soat tool converter with an action', () => {
    expect(
      validateIngestionRule({
        toolId: 'tool_a',
        agentId: null,
        toolType: 'soat',
        action: 'list-documents',
        contentTypeGlob: 'image/*',
      })
    ).toBeNull();
  });

  test('accepts an http tool converter with no action', () => {
    expect(
      validateIngestionRule({
        toolId: 'tool_a',
        agentId: null,
        toolType: 'http',
        action: null,
        contentTypeGlob: 'image/*',
      })
    ).toBeNull();
  });

  test('rejects a malformed content_type_glob', () => {
    expect(
      validateIngestionRule({
        toolId: 'tool_a',
        agentId: null,
        toolType: 'http',
        action: null,
        contentTypeGlob: 'not-a-mime-glob',
      })
    ).toMatch(/glob/i);
  });

  test('rejects an empty content_type_glob', () => {
    expect(
      validateIngestionRule({
        toolId: 'tool_a',
        agentId: null,
        toolType: 'http',
        action: null,
        contentTypeGlob: '',
      })
    ).toMatch(/glob/i);
  });

  test('accepts a fully wildcarded content_type_glob', () => {
    expect(
      validateIngestionRule({
        toolId: 'tool_a',
        agentId: null,
        toolType: 'http',
        action: null,
        contentTypeGlob: '*/*',
      })
    ).toBeNull();
  });
});

// ── CRUD ─────────────────────────────────────────────────────────────────────

describe('IngestionRule CRUD', () => {
  let projectId: number;
  let httpToolId: number;
  let soatToolId: number;
  let clientToolId: number;
  let agentId: number;

  beforeAll(async () => {
    const project = await db.Project.create({
      name: 'Ingestion Rules Lib Test',
    });
    projectId = project.id;

    const httpTool = await db.Tool.create({
      projectId,
      type: 'http',
      name: 'ocr-http-tool',
      execute: { url: 'https://example.com/ocr', method: 'POST' },
    });
    httpToolId = httpTool.id;

    const soatTool = await db.Tool.create({
      projectId,
      type: 'soat',
      name: 'ocr-soat-tool',
      actions: ['list-documents'],
    });
    soatToolId = soatTool.id;

    const clientTool = await db.Tool.create({
      projectId,
      type: 'client',
      name: 'ocr-client-tool',
    });
    clientToolId = clientTool.id;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Ingestion Rules Provider',
      provider: 'openai',
      defaultModel: 'gpt-4o-mini',
      baseUrl: null,
      config: null,
      secretId: null,
    });

    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Vision Agent',
    });
    agentId = agent.id;
  });

  describe('createIngestionRule', () => {
    test('creates a tool converter rule', async () => {
      const rule = await createIngestionRule({
        projectId,
        contentTypeGlob: 'image/png',
        toolId: httpToolId,
        fileDelivery: 'base64',
        chunkStrategy: 'whole',
      });

      expect(rule.id).toBeDefined();
      expect(rule.projectId).toBeDefined();
      expect(rule.contentTypeGlob).toBe('image/png');
      expect(rule.toolId).toBeDefined();
      expect(rule.agentId).toBeNull();
      expect(rule.nativeExtraction).toBe('first');
      expect(rule.fileDelivery).toBe('base64');
      expect(rule.chunkStrategy).toBe('whole');
    });

    test('creates an agent converter rule', async () => {
      const rule = await createIngestionRule({
        projectId,
        contentTypeGlob: 'application/pdf',
        agentId,
        nativeExtraction: 'skip',
      });

      expect(rule.agentId).toBeDefined();
      expect(rule.toolId).toBeNull();
      expect(rule.nativeExtraction).toBe('skip');
    });

    test('creates a soat tool converter rule with an action', async () => {
      const rule = await createIngestionRule({
        projectId,
        contentTypeGlob: 'audio/mpeg',
        toolId: soatToolId,
        action: 'list-documents',
      });

      expect(rule.action).toBe('list-documents');
    });

    test('rejects a soat tool converter rule with no action', async () => {
      await expect(
        createIngestionRule({
          projectId,
          contentTypeGlob: 'audio/wav',
          toolId: soatToolId,
        })
      ).rejects.toThrow(DomainError);
    });

    test('rejects a client tool as converter', async () => {
      await expect(
        createIngestionRule({
          projectId,
          contentTypeGlob: 'audio/ogg',
          toolId: clientToolId,
        })
      ).rejects.toThrow(DomainError);
    });

    test('rejects both tool_id and agent_id set', async () => {
      await expect(
        createIngestionRule({
          projectId,
          contentTypeGlob: 'audio/flac',
          toolId: httpToolId,
          agentId,
        })
      ).rejects.toThrow(DomainError);
    });

    test('rejects neither tool_id nor agent_id set', async () => {
      await expect(
        createIngestionRule({
          projectId,
          contentTypeGlob: 'audio/aac',
        })
      ).rejects.toThrow(DomainError);
    });

    test('rejects an unknown tool_id', async () => {
      await expect(
        createIngestionRule({
          projectId,
          contentTypeGlob: 'audio/webm',
          toolId: 999999999,
        })
      ).rejects.toThrow(DomainError);
    });

    test('rejects a duplicate content_type_glob in the same project', async () => {
      await createIngestionRule({
        projectId,
        contentTypeGlob: 'image/gif',
        toolId: httpToolId,
      });

      await expect(
        createIngestionRule({
          projectId,
          contentTypeGlob: 'image/gif',
          toolId: httpToolId,
        })
      ).rejects.toThrow(DomainError);
    });
  });

  describe('getIngestionRule', () => {
    test('returns a created rule by id', async () => {
      const created = await createIngestionRule({
        projectId,
        contentTypeGlob: 'image/webp',
        toolId: httpToolId,
      });

      const fetched = await getIngestionRule({ id: created.id });
      expect(fetched.id).toBe(created.id);
      expect(fetched.contentTypeGlob).toBe('image/webp');
    });

    test('throws RESOURCE_NOT_FOUND for an unknown id', async () => {
      await expect(
        getIngestionRule({ id: 'igr_doesnotexist' })
      ).rejects.toThrow(DomainError);
    });
  });

  describe('listIngestionRules', () => {
    test('lists rules scoped to a project', async () => {
      const other = await db.Project.create({ name: 'Other Project' });
      await createIngestionRule({
        projectId: other.id,
        contentTypeGlob: 'image/bmp',
        toolId: (
          await db.Tool.create({
            projectId: other.id,
            type: 'http',
            name: 'other-tool',
          })
        ).id,
      });

      const rules = await listIngestionRules({ projectIds: [projectId] });
      expect(rules.length).toBeGreaterThan(0);
      expect(
        rules.every((r) => {
          return r.projectId;
        })
      ).toBe(true);
    });
  });

  describe('updateIngestionRule', () => {
    test('updates the chunk strategy', async () => {
      const created = await createIngestionRule({
        projectId,
        contentTypeGlob: 'image/tiff',
        toolId: httpToolId,
      });

      const updated = await updateIngestionRule({
        id: created.id,
        chunkStrategy: 'size',
        chunkSize: 500,
      });

      expect(updated.chunkStrategy).toBe('size');
      expect(updated.chunkSize).toBe(500);
    });

    test('switches converter from tool to agent', async () => {
      const created = await createIngestionRule({
        projectId,
        contentTypeGlob: 'image/svg+xml',
        toolId: httpToolId,
      });

      const updated = await updateIngestionRule({
        id: created.id,
        toolId: null,
        agentId,
      });

      expect(updated.toolId).toBeNull();
      expect(updated.agentId).toBeDefined();
    });

    test('rejects setting both tool_id and agent_id', async () => {
      const created = await createIngestionRule({
        projectId,
        contentTypeGlob: 'image/avif',
        toolId: httpToolId,
      });

      await expect(
        updateIngestionRule({ id: created.id, agentId })
      ).rejects.toThrow(DomainError);
    });

    test('throws RESOURCE_NOT_FOUND for an unknown id', async () => {
      await expect(
        updateIngestionRule({ id: 'igr_doesnotexist', chunkStrategy: 'whole' })
      ).rejects.toThrow(DomainError);
    });
  });

  describe('deleteIngestionRule', () => {
    test('deletes a rule', async () => {
      const created = await createIngestionRule({
        projectId,
        contentTypeGlob: 'image/heic',
        toolId: httpToolId,
      });

      await deleteIngestionRule({ id: created.id });

      await expect(getIngestionRule({ id: created.id })).rejects.toThrow(
        DomainError
      );
    });

    test('throws RESOURCE_NOT_FOUND for an unknown id', async () => {
      await expect(
        deleteIngestionRule({ id: 'igr_doesnotexist' })
      ).rejects.toThrow(DomainError);
    });
  });
});

// ── resolveIngestionRule ─────────────────────────────────────────────────────

describe('resolveIngestionRule', () => {
  let projectId: number;
  let httpToolId: number;

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'Resolve Rule Lib Test' });
    projectId = project.id;

    const httpTool = await db.Tool.create({
      projectId,
      type: 'http',
      name: 'resolve-http-tool',
      execute: { url: 'https://example.com/ocr', method: 'POST' },
    });
    httpToolId = httpTool.id;

    await createIngestionRule({
      projectId,
      contentTypeGlob: '*/*',
      toolId: httpToolId,
    });
    await createIngestionRule({
      projectId,
      contentTypeGlob: 'image/*',
      toolId: httpToolId,
    });
    await createIngestionRule({
      projectId,
      contentTypeGlob: 'image/png',
      toolId: httpToolId,
    });
    await createIngestionRule({
      projectId,
      contentTypeGlob: 'audio/mpeg',
      toolId: httpToolId,
    });
  });

  test('picks the exact match over wildcard matches', async () => {
    const rule = await resolveIngestionRule({
      projectId,
      contentType: 'image/png',
    });
    expect(rule?.contentTypeGlob).toBe('image/png');
  });

  test('picks the subtype wildcard over the full wildcard', async () => {
    const rule = await resolveIngestionRule({
      projectId,
      contentType: 'image/jpeg',
    });
    expect(rule?.contentTypeGlob).toBe('image/*');
  });

  test('falls back to the full wildcard when nothing more specific matches', async () => {
    const rule = await resolveIngestionRule({
      projectId,
      contentType: 'text/csv',
    });
    expect(rule?.contentTypeGlob).toBe('*/*');
  });

  test('matches an exact non-wildcard glob for its own content type', async () => {
    const rule = await resolveIngestionRule({
      projectId,
      contentType: 'audio/mpeg',
    });
    expect(rule?.contentTypeGlob).toBe('audio/mpeg');
  });

  test('returns null when no rule matches and no wildcard rule exists', async () => {
    const other = await db.Project.create({ name: 'No Rules Project' });
    const rule = await resolveIngestionRule({
      projectId: other.id,
      contentType: 'image/png',
    });
    expect(rule).toBeNull();
  });
});

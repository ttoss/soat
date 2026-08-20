import { db } from 'src/db';
import {
  createIngestionRule,
  resolveIngestionRule,
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
        toolType: 'builtin',
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
        toolType: 'builtin',
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
    expect(rule?.content_type_glob).toBe('image/png');
  });

  test('picks the subtype wildcard over the full wildcard', async () => {
    const rule = await resolveIngestionRule({
      projectId,
      contentType: 'image/jpeg',
    });
    expect(rule?.content_type_glob).toBe('image/*');
  });

  test('falls back to the full wildcard when nothing more specific matches', async () => {
    const rule = await resolveIngestionRule({
      projectId,
      contentType: 'text/csv',
    });
    expect(rule?.content_type_glob).toBe('*/*');
  });

  test('matches an exact non-wildcard glob for its own content type', async () => {
    const rule = await resolveIngestionRule({
      projectId,
      contentType: 'audio/mpeg',
    });
    expect(rule?.content_type_glob).toBe('audio/mpeg');
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

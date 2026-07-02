import { db } from 'src/db';
import {
  buildDependencyGraph,
  buildResolvedParamsMap,
  collectParamRefs,
  collectRefAttrs,
  collectRefs,
  getMissingParams,
  isParam,
  isRef,
  isRefAttr,
  isSub,
  lookupActorInternalId,
  lookupAgentInternalId,
  lookupChatInternalId,
  lookupPolicyInternalIds,
  lookupToolInternalId,
  parseRefAttr,
  resolveParamExpressions,
  resolveRefs,
  resolveWorkingTemplate,
  topologicalSort,
} from 'src/lib/formationsHelpers';
import type { FormationTemplate } from 'src/lib/formationsTypes';

describe('formationsHelpers', () => {
  // ── isRef ────────────────────────────────────────────────────────────────

  describe('isRef', () => {
    test('returns true for a valid ref expression', () => {
      expect(isRef({ ref: 'MyAgent' })).toBe(true);
    });

    test('returns false for multi-key object', () => {
      expect(isRef({ ref: 'x', extra: 1 })).toBe(false);
    });

    test('returns false for a non-ref key', () => {
      expect(isRef({ param: 'x' })).toBe(false);
    });

    test('returns false for an array', () => {
      expect(isRef([{ ref: 'x' }])).toBe(false);
    });

    test('returns false for null', () => {
      expect(isRef(null)).toBe(false);
    });

    test('returns false for a string ref value', () => {
      expect(isRef({ ref: 123 })).toBe(false);
    });
  });

  // ── collectRefs ───────────────────────────────────────────────────────────

  describe('collectRefs', () => {
    test('returns the ref string from a ref expression', () => {
      expect(collectRefs({ ref: 'AgentA' })).toEqual(['AgentA']);
    });

    test('collects refs from an array', () => {
      expect(collectRefs([{ ref: 'A' }, { ref: 'B' }])).toEqual(['A', 'B']);
    });

    test('collects refs nested inside an object', () => {
      expect(
        collectRefs({ agent_id: { ref: 'AgentA' }, name: 'fixed' })
      ).toEqual(['AgentA']);
    });

    test('returns empty for a plain string', () => {
      expect(collectRefs('just a string')).toEqual([]);
    });

    test('returns empty for a number', () => {
      expect(collectRefs(42)).toEqual([]);
    });
  });

  // ── resolveRefs ───────────────────────────────────────────────────────────

  describe('resolveRefs', () => {
    test('replaces a ref with its resolved value', () => {
      const map = new Map([['AgentA', 'agt_real_1']]);
      expect(resolveRefs({ ref: 'AgentA' }, map)).toBe('agt_real_1');
    });

    test('resolves refs inside an array', () => {
      const map = new Map([['X', 'resolved_x']]);
      expect(resolveRefs([{ ref: 'X' }, 'literal'], map)).toEqual([
        'resolved_x',
        'literal',
      ]);
    });

    test('resolves refs nested inside an object', () => {
      const map = new Map([['A', 'id_a']]);
      const result = resolveRefs(
        { agent_id: { ref: 'A' }, name: 'fixed' },
        map
      );
      expect(result).toEqual({ agent_id: 'id_a', name: 'fixed' });
    });

    test('passes through non-ref primitives unchanged', () => {
      const map = new Map<string, string>();
      expect(resolveRefs('hello', map)).toBe('hello');
      expect(resolveRefs(99, map)).toBe(99);
      expect(resolveRefs(null, map)).toBeNull();
    });

    test('throws when a ref cannot be resolved', () => {
      const map = new Map<string, string>();
      expect(() => {
        return resolveRefs({ ref: 'Missing' }, map);
      }).toThrow('Unresolved ref: Missing');
    });
  });

  // ── isRefAttr ─────────────────────────────────────────────────────────────

  describe('isRefAttr', () => {
    test('returns true for a valid ref_attr expression', () => {
      expect(isRefAttr({ ref_attr: 'AgentA.id' })).toBe(true);
    });

    test('returns false for a ref expression', () => {
      expect(isRefAttr({ ref: 'AgentA' })).toBe(false);
    });

    test('returns false for null', () => {
      expect(isRefAttr(null)).toBe(false);
    });
  });

  // ── collectRefAttrs ───────────────────────────────────────────────────────

  describe('collectRefAttrs', () => {
    test('extracts a single ref_attr string', () => {
      expect(collectRefAttrs({ ref_attr: 'MyAgent.name' })).toEqual([
        'MyAgent.name',
      ]);
    });

    test('collects from nested objects', () => {
      const obj = { tool_id: { ref_attr: 'Tool.id' }, other: 'fixed' };
      expect(collectRefAttrs(obj)).toEqual(['Tool.id']);
    });

    test('returns empty for a plain string', () => {
      expect(collectRefAttrs('x')).toEqual([]);
    });
  });

  // ── parseRefAttr ──────────────────────────────────────────────────────────

  describe('parseRefAttr', () => {
    test('parses logicalId and attrName correctly', () => {
      expect(parseRefAttr('MyAgent.name')).toEqual({
        logicalId: 'MyAgent',
        attrName: 'name',
      });
    });

    test('handles a dotted attrName (only first dot splits)', () => {
      expect(parseRefAttr('MyAgent.some.nested')).toEqual({
        logicalId: 'MyAgent',
        attrName: 'some.nested',
      });
    });

    test('returns null when there is no dot', () => {
      expect(parseRefAttr('NoDot')).toBeNull();
    });

    test('returns null when the dot is at position 0', () => {
      expect(parseRefAttr('.attrOnly')).toBeNull();
    });

    test('returns null when attrName is empty', () => {
      expect(parseRefAttr('LogicalId.')).toBeNull();
    });
  });

  // ── isParam ───────────────────────────────────────────────────────────────

  describe('isParam', () => {
    test('returns true for a param expression', () => {
      expect(isParam({ param: 'envName' })).toBe(true);
    });

    test('returns false for non-param', () => {
      expect(isParam({ ref: 'x' })).toBe(false);
    });

    test('returns false for null', () => {
      expect(isParam(null)).toBe(false);
    });
  });

  // ── isSub ─────────────────────────────────────────────────────────────────

  describe('isSub', () => {
    test('returns true for a sub expression', () => {
      expect(isSub({ sub: 'prefix-${name}' })).toBe(true);
    });

    test('returns false for param', () => {
      expect(isSub({ param: 'x' })).toBe(false);
    });
  });

  // ── collectParamRefs ──────────────────────────────────────────────────────

  describe('collectParamRefs', () => {
    test('extracts a single param name', () => {
      expect(collectParamRefs({ param: 'region' })).toEqual(['region']);
    });

    test('extracts param names from a sub expression', () => {
      expect(collectParamRefs({ sub: 'prefix-${env}-${region}' })).toEqual([
        'env',
        'region',
      ]);
    });

    test('collects from an array', () => {
      expect(collectParamRefs([{ param: 'a' }, { param: 'b' }])).toEqual([
        'a',
        'b',
      ]);
    });

    test('collects from nested objects', () => {
      const obj = { name: { param: 'agentName' }, count: 3 };
      expect(collectParamRefs(obj)).toEqual(['agentName']);
    });

    test('returns empty for a plain string', () => {
      expect(collectParamRefs('literal')).toEqual([]);
    });
  });

  // ── resolveParamExpressions ───────────────────────────────────────────────

  describe('resolveParamExpressions', () => {
    test('resolves a param expression', () => {
      const map = new Map([['env', 'production']]);
      expect(resolveParamExpressions({ param: 'env' }, map)).toBe('production');
    });

    test('resolves placeholders in a sub expression', () => {
      const map = new Map([
        ['env', 'prod'],
        ['region', 'us-east-1'],
      ]);
      expect(
        resolveParamExpressions({ sub: 'agent-${env}-${region}' }, map)
      ).toBe('agent-prod-us-east-1');
    });

    test('leaves body.xxx refs in sub expressions untouched', () => {
      const map = new Map([['env', 'prod']]);
      expect(resolveParamExpressions({ sub: '${env}-${body.name}' }, map)).toBe(
        'prod-${body.name}'
      );
    });

    test('resolves inside an array', () => {
      const map = new Map([['x', 'val']]);
      expect(resolveParamExpressions([{ param: 'x' }, 'literal'], map)).toEqual(
        ['val', 'literal']
      );
    });

    test('resolves inside a nested object', () => {
      const map = new Map([['n', 'hello']]);
      const result = resolveParamExpressions(
        { name: { param: 'n' }, count: 5 },
        map
      );
      expect(result).toEqual({ name: 'hello', count: 5 });
    });

    test('passes through non-param primitives unchanged', () => {
      const map = new Map<string, string>();
      expect(resolveParamExpressions('literal', map)).toBe('literal');
      expect(resolveParamExpressions(7, map)).toBe(7);
    });

    test('resolves an unresolved param to undefined (use previous value)', () => {
      expect(
        resolveParamExpressions({ param: 'missing' }, new Map())
      ).toBeUndefined();
    });

    test('resolves a sub with an unresolved placeholder to undefined', () => {
      expect(
        resolveParamExpressions({ sub: '${missing}' }, new Map())
      ).toBeUndefined();
    });

    test('drops the property holding an unresolved param when serialized', () => {
      const result = resolveParamExpressions(
        { name: 'keep', value: { param: 'missing' } },
        new Map()
      );
      expect(result).toEqual({ name: 'keep', value: undefined });
      expect(JSON.stringify(result)).toBe('{"name":"keep"}');
    });
  });

  // ── buildResolvedParamsMap ────────────────────────────────────────────────

  describe('buildResolvedParamsMap', () => {
    test('returns empty map when template has no parameters', () => {
      const template: FormationTemplate = { resources: {} };
      expect(buildResolvedParamsMap(template)).toEqual(new Map());
    });

    test('uses provided values over defaults', () => {
      const template: FormationTemplate = {
        resources: {},
        parameters: { env: { default: 'dev' } },
      };
      const map = buildResolvedParamsMap(template, { env: 'prod' });
      expect(map.get('env')).toBe('prod');
    });

    test('falls back to default when not provided', () => {
      const template: FormationTemplate = {
        resources: {},
        parameters: { env: { default: 'dev' } },
      };
      const map = buildResolvedParamsMap(template);
      expect(map.get('env')).toBe('dev');
    });

    test('omits parameters with no value and no default', () => {
      const template: FormationTemplate = {
        resources: {},
        parameters: { required: {} },
      };
      const map = buildResolvedParamsMap(template);
      expect(map.has('required')).toBe(false);
    });

    test('omits an unsupplied use_previous_value param (left unresolved)', () => {
      const template: FormationTemplate = {
        resources: {},
        parameters: {
          env: { default: 'dev' },
          secret: { use_previous_value: true },
        },
      };
      const map = buildResolvedParamsMap(template, { env: 'prod' });
      expect(map.get('env')).toBe('prod');
      expect(map.has('secret')).toBe(false);
    });
  });

  // ── getMissingParams ──────────────────────────────────────────────────────

  describe('getMissingParams', () => {
    test('returns empty when all used params are provided', () => {
      const template: FormationTemplate = {
        resources: {
          A: { type: 'agents', properties: { name: { param: 'agentName' } } },
        },
        parameters: { agentName: {} },
      };
      const missing = getMissingParams(template, { agentName: 'my-agent' });
      expect(missing).toEqual([]);
    });

    test('reports a missing required param', () => {
      const template: FormationTemplate = {
        resources: {
          A: { type: 'agents', properties: { name: { param: 'agentName' } } },
        },
        parameters: { agentName: {} },
      };
      const missing = getMissingParams(template);
      expect(missing).toContain('agentName');
    });

    test('accepts a default as satisfying the requirement', () => {
      const template: FormationTemplate = {
        resources: {
          A: { type: 'agents', properties: { name: { param: 'agentName' } } },
        },
        parameters: { agentName: { default: 'default-agent' } },
      };
      expect(getMissingParams(template)).toEqual([]);
    });

    test('treats a use_previous_value param as satisfied on update', () => {
      const template: FormationTemplate = {
        resources: {
          A: { type: 'agents', properties: { name: { param: 'agentName' } } },
        },
        parameters: { agentName: { use_previous_value: true } },
      };
      expect(getMissingParams(template, undefined, true)).toEqual([]);
    });

    test('use_previous_value does not satisfy on create (no previous value)', () => {
      const template: FormationTemplate = {
        resources: {
          A: { type: 'agents', properties: { name: { param: 'agentName' } } },
        },
        parameters: { agentName: { use_previous_value: true } },
      };
      expect(getMissingParams(template, undefined, false)).toContain(
        'agentName'
      );
    });
  });

  // ── resolveWorkingTemplate ────────────────────────────────────────────────

  describe('resolveWorkingTemplate', () => {
    test('returns the template unchanged when it declares no parameters', () => {
      const template: FormationTemplate = {
        resources: { M: { type: 'memory', properties: { name: 'lit' } } },
      };
      expect(resolveWorkingTemplate({ template })).toBe(template);
    });

    test('substitutes provided parameter values', () => {
      const template: FormationTemplate = {
        parameters: { Name: {} },
        resources: {
          M: { type: 'memory', properties: { name: { param: 'Name' } } },
        },
      };
      const result = resolveWorkingTemplate({
        template,
        parameters: { Name: 'resolved' },
      });
      expect(result.resources.M.properties.name).toBe('resolved');
    });

    test('strips an omitted use_previous_value param expression to undefined', () => {
      const template: FormationTemplate = {
        parameters: { Secret: { use_previous_value: true } },
        resources: {
          S: {
            type: 'secret',
            properties: { name: 'n', value: { param: 'Secret' } },
          },
        },
      };
      // No value supplied for Secret — it is declared use_previous_value.
      const result = resolveWorkingTemplate({ template });
      // The raw `{ param: ... }` must not survive — it resolves to undefined so
      // the field is dropped and the stored value is preserved.
      expect(result.resources.S.properties.value).toBeUndefined();
      expect(JSON.stringify(result.resources.S.properties)).toBe(
        '{"name":"n"}'
      );
    });
  });

  // ── buildDependencyGraph ──────────────────────────────────────────────────

  describe('buildDependencyGraph', () => {
    test('creates a graph with no dependencies for independent resources', () => {
      const template: FormationTemplate = {
        resources: {
          A: { type: 'agents', properties: {} },
          B: { type: 'agents', properties: {} },
        },
      };
      const graph = buildDependencyGraph(template);
      expect(graph.get('A')?.size).toBe(0);
      expect(graph.get('B')?.size).toBe(0);
    });

    test('detects a ref dependency', () => {
      const template: FormationTemplate = {
        resources: {
          A: { type: 'agents', properties: {} },
          B: { type: 'actors', properties: { agent_id: { ref: 'A' } } },
        },
      };
      const graph = buildDependencyGraph(template);
      expect(graph.get('B')?.has('A')).toBe(true);
      expect(graph.get('A')?.size).toBe(0);
    });

    test('detects depends_on dependencies', () => {
      const template: FormationTemplate = {
        resources: {
          A: { type: 'agents', properties: {} },
          B: { type: 'agents', properties: {}, depends_on: ['A'] },
        },
      };
      const graph = buildDependencyGraph(template);
      expect(graph.get('B')?.has('A')).toBe(true);
    });

    test('ignores self-references', () => {
      const template: FormationTemplate = {
        resources: {
          A: { type: 'agents', properties: { self: { ref: 'A' } } },
        },
      };
      const graph = buildDependencyGraph(template);
      expect(graph.get('A')?.has('A')).toBe(false);
    });
  });

  // ── topologicalSort ───────────────────────────────────────────────────────

  describe('topologicalSort', () => {
    test('sorts two independent nodes in any valid order', () => {
      const graph = new Map([
        ['A', new Set<string>()],
        ['B', new Set<string>()],
      ]);
      const sorted = topologicalSort(graph);
      expect(sorted).not.toBeNull();
      expect(sorted).toHaveLength(2);
    });

    test('places dependencies before dependents', () => {
      const graph = new Map([
        ['A', new Set<string>()],
        ['B', new Set(['A'])],
      ]);
      const sorted = topologicalSort(graph);
      expect(sorted).not.toBeNull();
      expect(sorted!.indexOf('A')).toBeLessThan(sorted!.indexOf('B'));
    });

    test('returns null for a cycle', () => {
      const graph = new Map([
        ['A', new Set(['B'])],
        ['B', new Set(['A'])],
      ]);
      expect(topologicalSort(graph)).toBeNull();
    });

    test('handles an empty graph', () => {
      expect(topologicalSort(new Map())).toEqual([]);
    });
  });

  describe('lookup*InternalId helpers', () => {
    let projectId: number;
    let aiProviderId: number;

    beforeAll(async () => {
      const project = await db.Project.create({
        name: 'formationsHelpers Lookup Test',
      });
      projectId = project.id;

      const aiProvider = await db.AiProvider.create({
        projectId,
        name: 'Lookup Test Provider',
        provider: 'openai',
        defaultModel: 'gpt-4o-mini',
        baseUrl: null,
        config: null,
        secretId: null,
      });
      aiProviderId = aiProvider.id;
    });

    test('lookupActorInternalId resolves a public id to its internal id', async () => {
      const actor = await db.Actor.create({
        projectId,
        name: 'Lookup Test Actor',
      });

      await expect(lookupActorInternalId(actor.publicId)).resolves.toBe(
        actor.id
      );
    });

    test('lookupActorInternalId throws for an unknown public id', async () => {
      await expect(
        lookupActorInternalId('actor_doesnotexist000')
      ).rejects.toThrow('Actor not found: actor_doesnotexist000');
    });

    test('lookupAgentInternalId resolves a public id to its internal id', async () => {
      const agent = await db.Agent.create({
        projectId,
        aiProviderId,
        name: 'Lookup Test Agent',
      });

      await expect(lookupAgentInternalId(agent.publicId)).resolves.toBe(
        agent.id
      );
    });

    test('lookupToolInternalId resolves a public id to its internal id', async () => {
      const tool = await db.Tool.create({
        projectId,
        type: 'client',
        name: 'lookup-test-tool',
      });

      await expect(lookupToolInternalId(tool.publicId)).resolves.toBe(tool.id);
    });

    test('lookupChatInternalId resolves a public id to its internal id', async () => {
      const chat = await db.Chat.create({
        projectId,
        aiProviderId,
      });

      await expect(lookupChatInternalId(chat.publicId)).resolves.toBe(chat.id);
    });

    test('lookupChatInternalId throws for an unknown public id', async () => {
      await expect(
        lookupChatInternalId('chat_doesnotexist000')
      ).rejects.toThrow('Chat not found: chat_doesnotexist000');
    });

    test('lookupPolicyInternalIds resolves multiple public ids to internal ids', async () => {
      const policyA = await db.Policy.create({ document: { statement: [] } });
      const policyB = await db.Policy.create({ document: { statement: [] } });

      await expect(
        lookupPolicyInternalIds([policyA.publicId, policyB.publicId])
      ).resolves.toEqual([policyA.id, policyB.id]);
    });

    test('lookupPolicyInternalIds throws when one public id is missing', async () => {
      const policyA = await db.Policy.create({ document: { statement: [] } });

      await expect(
        lookupPolicyInternalIds([policyA.publicId, 'pol_doesnotexist000'])
      ).rejects.toThrow('Policy not found: pol_doesnotexist000');
    });
  });
});

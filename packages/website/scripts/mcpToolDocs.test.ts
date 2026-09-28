import assert from 'node:assert';
import test from 'node:test';

import { loadTools, loadToolSurface } from './mcpToolDocs';
import { loadModules } from './openapiReferenceHelpers';

const documentedTools = () => {
  const modules = loadModules();
  const surface = loadToolSurface(modules);
  return new Map(
    modules
      .flatMap((mod) => {
        return loadTools({ mod, surface });
      })
      .map((tool) => {
        return [tool.name, tool] as const;
      })
  );
};

const argumentNames = (toolName: string) => {
  const tool = documentedTools().get(toolName);
  assert.ok(tool, `${toolName} is documented`);
  return tool.args.map((arg) => {
    return arg.name;
  });
};

test('a field the tool call cannot send is not documented as an argument', () => {
  assert.ok(!argumentNames('create-agent-generation').includes('stream'));
});

test('a field pinned for every tool call is not documented as an argument', () => {
  for (const tool of [
    'create-agent-generation',
    'generate-conversation-message',
    'generate-session-response',
    'create-decision',
  ]) {
    assert.ok(!argumentNames(tool).includes('wait'), `${tool} documents wait`);
  }
});

test('a field the tool caller chooses stays documented', () => {
  assert.ok(argumentNames('start-orchestration-run').includes('wait'));
  assert.ok(argumentNames('generate-session-response').includes('session_id'));
});

test('an argument the spec describes only through the derived schema keeps its type', () => {
  const tool = documentedTools().get('add-session-message');
  const toolContext = tool?.args.find((arg) => {
    return arg.name === 'tool_context';
  });
  assert.strictEqual(toolContext?.type, 'object | null');
});

test('every derived tool is documented with exactly its arguments', () => {
  const modules = loadModules();
  const surface = loadToolSurface(modules);
  const documented = documentedTools();
  for (const tool of surface.values()) {
    const doc = documented.get(tool.name);
    assert.ok(doc, `${tool.name} is documented`);
    assert.deepStrictEqual(
      doc.args.map((arg) => {
        return arg.name;
      }),
      Object.keys(tool.inputSchema.properties ?? {}),
      tool.name
    );
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const serverRoot = fileURLToPath(
  new URL('../../packages/server/', import.meta.url)
);
const specDir = path.join(serverRoot, 'src/rest/openapi/v1');
const { load } = createRequire(path.join(serverRoot, 'package.json'))(
  'js-yaml'
);

/**
 * A tool call is one request returning one result: a `202` it cannot poll
 * leaves an agent step or an orchestration `tool` node holding a record with
 * no answer in it. So every `wait` either carries `x-soat-tool-forced: true`
 * or is named here, with the reason polling it is the point of the call
 * (`.claude/rules/sync-async.md`).
 */
const TOOL_CHOOSES_WAIT = {
  ingestDocument:
    'ingestion runs as long as the file takes to extract and embed',
  reingestDocument:
    'ingestion runs as long as the file takes to extract and embed',
  StartOrchestrationRunRequest: 'a run can pause on human input or run long',
  startEvalRun: 'a run scores a whole dataset',
};

/** The `wait` fields declared directly on `node`. */
const ownWaitFields = (node) => {
  const own = [];
  if (node.in === 'query' && node.name === 'wait') own.push(node);
  if (node.properties?.wait) own.push(node.properties.wait);
  return own;
};

const collectWaitFields = (node, owner, found) => {
  if (!node || typeof node !== 'object') return;
  const key = node.operationId ?? owner;
  for (const field of ownWaitFields(node)) found.push({ owner: key, field });
  for (const value of Object.values(node)) {
    collectWaitFields(value, key, found);
  }
};

/**
 * Every `wait` query parameter or body property, keyed by the operationId that
 * declares it, or by the component schema for a body written once and `$ref`d.
 */
const loadSpecs = () => {
  return fs
    .readdirSync(specDir)
    .filter((file) => {
      return file.endsWith('.yaml');
    })
    .map((file) => {
      return load(fs.readFileSync(path.join(specDir, file), 'utf8'));
    });
};

const waitFields = () => {
  const found = [];
  for (const spec of loadSpecs()) {
    collectWaitFields(spec.paths, undefined, found);
    for (const [name, schema] of Object.entries(
      spec.components?.schemas ?? {}
    )) {
      collectWaitFields(schema, name, found);
    }
  }
  return found;
};

/**
 * The one sentence a pinned `wait` states. Every generated surface (the SDK
 * types, the CLI and API reference pages) copies the spec's description, so
 * the sentence is held here and checked on every pinned field.
 */
const TOOL_WAIT_SENTENCE = 'A tool call, `builtin` or MCP, always waits.';

const syncAsyncPage = fileURLToPath(
  new URL(
    '../../packages/website/docs/advanced/sync-and-async.md',
    import.meta.url
  )
);

/** `createAgentGeneration` → `create-agent-generation`, the tool's name. */
const toolName = (operationId) => {
  return operationId.replace(/[A-Z]/g, (letter) => {
    return `-${letter.toLowerCase()}`;
  });
};

/** The body schema an operation `$ref`s by name, if it names one. */
const bodySchemaName = (operation) => {
  const ref =
    operation?.requestBody?.content?.['application/json']?.schema?.$ref;
  return typeof ref === 'string' ? ref.split('/').pop() : undefined;
};

/** The operationId of each operation, keyed by the body schema it `$ref`s. */
const operationsByBodySchema = () => {
  const operations = loadSpecs().flatMap((spec) => {
    return Object.values(spec.paths ?? {}).flatMap((methods) => {
      return Object.values(methods);
    });
  });
  return Object.fromEntries(
    operations
      .map((operation) => {
        return [bodySchemaName(operation), operation?.operationId];
      })
      .filter(([name]) => {
        return name !== undefined;
      })
  );
};

/** The tool names a sentence of the page names in backticks. */
const toolNamesIn = (sentence) => {
  return [...sentence.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)]
    .map((match) => {
      return match[1];
    })
    .sort();
};

const isPinned = (field) => {
  return field['x-soat-tool-forced'] !== undefined;
};

describe('wait on the tool surface', () => {
  const fields = waitFields();

  test('the specs declare wait fields', () => {
    assert.ok(fields.length > 0);
  });

  test('every wait is pinned for tool calls or named as the tool caller’s choice', () => {
    const unanswered = fields
      .filter(({ owner, field }) => {
        return !isPinned(field) && !(owner in TOOL_CHOOSES_WAIT);
      })
      .map(({ owner }) => {
        return owner;
      });

    assert.deepEqual(unanswered, []);
  });

  test('a pinned wait is pinned to true', () => {
    const wrong = fields
      .filter(({ field }) => {
        const pin = field['x-soat-tool-forced'];
        return pin !== undefined && pin !== true;
      })
      .map(({ owner }) => {
        return owner;
      });

    assert.deepEqual(wrong, []);
  });

  test('every named owner still declares an unpinned wait', () => {
    const unpinnedOwners = new Set(
      fields
        .filter(({ field }) => {
          return !isPinned(field);
        })
        .map(({ owner }) => {
          return owner;
        })
    );
    const stale = Object.keys(TOOL_CHOOSES_WAIT).filter((owner) => {
      return !unpinnedOwners.has(owner);
    });

    assert.deepEqual(stale, []);
  });
  test('a pinned wait states the tool-call sentence, and only a pinned one', () => {
    const wrong = fields
      .filter(({ field }) => {
        const says = (field.description ?? '')
          .replace(/\s+/g, ' ')
          .includes(TOOL_WAIT_SENTENCE);
        return isPinned(field) !== says;
      })
      .map(({ owner }) => {
        return owner;
      });

    assert.deepEqual(wrong, []);
  });

  test('the sync and async page names every pinned and every chosen tool', () => {
    const byBody = operationsByBodySchema();
    const toolOf = (owner) => {
      return toolName(byBody[owner] ?? owner);
    };
    const page = fs.readFileSync(syncAsyncPage, 'utf8');
    const paragraph = page.split('\n').find((line) => {
      return line.startsWith('**A tool call always waits');
    });
    assert.ok(paragraph, 'the page has the tool-call paragraph');
    const [pinnedPart, chosenPart = ''] = paragraph.split(
      'Runs that can pause'
    );

    const pinned = fields
      .filter(({ field }) => {
        return isPinned(field);
      })
      .map(({ owner }) => {
        return toolOf(owner);
      })
      .sort();
    const chosen = Object.keys(TOOL_CHOOSES_WAIT).map(toolOf).sort();

    assert.deepEqual(toolNamesIn(pinnedPart), pinned);
    assert.deepEqual(toolNamesIn(chosenPart), chosen);
  });
});

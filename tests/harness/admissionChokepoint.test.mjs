import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { mountedRoutes } from './iamRouteChecks.mjs';
import { stringsOnEveryPath } from './routeStrings.mjs';
import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');
const formationModulesDir = path.join(srcDir, 'lib/formation-modules');
const specDir = path.join(srcDir, 'rest/openapi/v1');
const { load } = createRequire(
  path.join(repoRoot, 'packages/server/package.json')
)('js-yaml');

const WRITE_METHODS = ['post', 'put', 'patch', 'delete'];
const ADMISSION_REFUSED_REF =
  './errors.yaml#/components/responses/AdmissionRefused';

/** Every operation admission can be declared for, as `METHOD path` → its responses. */
const declarableOperations = () => {
  const operations = [];
  for (const file of fs.readdirSync(specDir)) {
    if (!file.endsWith('.yaml')) continue;
    const spec = load(fs.readFileSync(path.join(specDir, file), 'utf-8'));
    for (const [route, item] of Object.entries(spec.paths ?? {})) {
      for (const method of WRITE_METHODS) {
        const operation = item[method];
        if (!operation?.['x-iam-action']) continue;
        operations.push({ method, route, operation });
      }
    }
  }
  return operations;
};

const declarableWrites = () => {
  return new Map(
    declarableOperations().map(({ method, route, operation }) => {
      return [`${method.toUpperCase()} ${route}`, operation.responses];
    })
  );
};

/** Source with comments dropped, so prose naming a symbol is not a hit. */
const code = (file) => {
  return stripComments(fs.readFileSync(file, 'utf-8'));
};

const sourceFiles = fs
  .readdirSync(srcDir, { recursive: true })
  .filter((entry) => {
    return entry.endsWith('.ts');
  });

/** Value imports of `file`, as `<module relative to src>#<name>`. */
const valueImports = (file) => {
  const imports = [];
  for (const match of code(file).matchAll(
    /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g
  )) {
    const [, names, specifier] = match;
    const module = specifier.startsWith('.')
      ? path.relative(srcDir, path.resolve(path.dirname(file), specifier))
      : specifier.startsWith('src/')
        ? specifier.slice('src/'.length)
        : null;
    if (module === null) continue;
    for (const raw of names.split(',')) {
      const entry = raw.trim();
      if (entry === '' || entry.startsWith('type ')) continue;
      imports.push(`${module}#${entry.split(/\s+as\s+/)[0]}`);
    }
  }
  return imports;
};

/** The lib creates and updates a formation module applies. */
const formationWrites = () => {
  const writes = new Set();
  for (const file of fs.readdirSync(formationModulesDir)) {
    if (!file.endsWith('FormationModule.ts')) continue;
    for (const imported of valueImports(path.join(formationModulesDir, file))) {
      if (/#(create|update)[A-Z]/.test(imported)) writes.add(imported);
    }
  }
  return writes;
};

/** The `writes` `entry` imports, as `entry → write`. */
const callsInto = (args) => {
  const { entry, writes } = args;
  return valueImports(path.join(srcDir, entry))
    .filter((imported) => {
      return writes.has(imported);
    })
    .map((imported) => {
      return `${entry} → ${imported}`;
    });
};

/**
 * Lib modules that call a formation write from inside a REST route's own
 * write, so the route's action is the one admission is asked about.
 */
const REACHED_ONLY_FROM_A_ROUTE = new Set([
  'lib/agentVersions.ts',
  'lib/conversationMessages.ts',
  'lib/deciderVersions.ts',
  'lib/documentVersions.ts',
  'lib/guardrailVersions.ts',
  'lib/orchestrationVersions.ts',
  'lib/playbookVersions.ts',
  'lib/workflowVersions.ts',
]);

/** Declarable writes whose route skips their action on some path. */
const unaskedWrites = () => {
  const routes = new Map(
    mountedRoutes().map((route) => {
      return [route.key, route];
    })
  );
  return declarableOperations()
    .filter(({ method, route, operation }) => {
      const mounted = routes.get(`${method} ${route}`);
      return (
        !mounted || !stringsOnEveryPath(mounted).has(operation['x-iam-action'])
      );
    })
    .map(({ method, route }) => {
      return `${method.toUpperCase()} ${route}`;
    });
};

/**
 * Routes with a branch that authorizes nothing because it writes nothing,
 * each with the reason; every other branch of a declarable write asks.
 */
const BRANCH_WRITES_NOTHING = new Map([
  [
    'POST /api/v1/chat/completions',
    'an unknown `chat_id` is answered `CHAT_NOT_FOUND` by the lib before any model call',
  ],
]);

/**
 * A declared write is asked about at two chokepoints: the REST middleware
 * (REST and `builtin`) and `defineFormationModule`. A write path reaching a lib
 * create or update around both executes with no question asked.
 */
describe('admission chokepoints', () => {
  test('every declarable write documents the refusal under 4XX and the 502', () => {
    const writes = declarableWrites();
    assert.ok(writes.has('POST /api/v1/agents/{agent_id}/generate'));
    const undocumented = [...writes]
      .filter(([, responses]) => {
        return (
          responses?.['4XX']?.$ref !== ADMISSION_REFUSED_REF ||
          responses?.['502'] === undefined
        );
      })
      .map(([operation]) => {
        return operation;
      });
    assert.deepEqual(undocumented, []);
  });

  test('the REST router mounts the admission middleware', () => {
    assert.match(
      code(path.join(srcDir, 'rest/router.ts')),
      /restRouter\.use\(admissionMiddleware\)/
    );
  });

  // The middleware asks only when the route authorizes under its action, so a
  // route that authenticates and checks nothing, or checks on one branch only,
  // executes unasked.
  test('every declarable write authorizes under its declared action on every path', () => {
    const unasked = unaskedWrites();
    assert.deepEqual(
      unasked.filter((operation) => {
        return !BRANCH_WRITES_NOTHING.has(operation);
      }),
      []
    );
    assert.deepEqual(
      [...BRANCH_WRITES_NOTHING.keys()].filter((operation) => {
        return !unasked.includes(operation);
      }),
      [],
      'an exemption whose route asks on every path is stale'
    );
  });

  test('defineFormationModule asks before a create and an update', () => {
    const source = code(
      path.join(formationModulesDir, 'defineFormationModule.ts')
    );
    assert.equal(source.match(/await admitWrite\(/g)?.length, 2);
  });

  test('a formation write is called only from a route or a formation module', () => {
    const writes = formationWrites();
    assert.ok(writes.has('lib/triggers#createTrigger'));
    const outside = sourceFiles
      .filter((entry) => {
        return (
          !entry.startsWith('rest/v1/') &&
          !entry.startsWith('lib/formation-modules/') &&
          !REACHED_ONLY_FROM_A_ROUTE.has(entry)
        );
      })
      .flatMap((entry) => {
        return callsInto({ entry, writes });
      });
    assert.deepEqual(outside, []);
  });

  test('every decision recorded as allowed outside isAllowed asks admission', () => {
    const recordsAllowed = sourceFiles.filter((entry) => {
      return /recordAuthorizationDecision\([^)]*allowed(?!: false)/s.test(
        code(path.join(srcDir, entry))
      );
    });
    const withoutAdmission = recordsAllowed.filter((entry) => {
      return !/\badmitAuthorized\(/.test(code(path.join(srcDir, entry)));
    });
    assert.deepEqual(withoutAdmission, []);
  });
});

/** The body of `export const <name> = ...` up to the next top-level const. */
const exportedBody = (file, name) => {
  const source = code(path.join(srcDir, file));
  const start = source.indexOf(`export const ${name} = `);
  assert.notEqual(start, -1, `${file} exports ${name}`);
  const end = source.indexOf('\nexport const ', start + 1);
  return source.slice(start, end === -1 ? undefined : end);
};

/**
 * Work the runtime does on its own (a generation, a tool call, a start) is
 * asked at the gates every such step crosses (`startChokepoint.test.mjs`
 * holds every step to them), all of which authorize through
 * `assertAllowedUnder`.
 */
describe('admission on internal work', () => {
  test('every start gate authorizes through assertAllowedUnder', () => {
    for (const [file, gate] of [
      ['lib/generationStartGate.ts', 'gateGenerationStart'],
      ['lib/toolCallGate.ts', 'gateToolCall'],
      ['lib/startGate.ts', 'gateStart'],
    ]) {
      assert.match(exportedBody(file, gate), /\bassertAllowedUnder\(/, gate);
    }
  });

  test('assertAllowedUnder asks admission on every allowed path', () => {
    const body = exportedBody('lib/turnAuthority.ts', 'assertAllowedUnder');
    assert.equal(body.match(/\badmitChecks\(/g)?.length, 2);
    assert.doesNotMatch(body, /\breturn;/);
    assert.match(
      code(path.join(srcDir, 'lib/turnAuthority.ts')),
      /const admitChecks = [\s\S]*?\bassertWorkAdmitted\(/
    );
  });

  test('only the REST middleware opens a request scope', () => {
    assert.deepEqual(
      sourceFiles.filter((entry) => {
        return (
          entry !== 'lib/admission.ts' &&
          /\brunInAdmissionScope\(/.test(code(path.join(srcDir, entry)))
        );
      }),
      ['middleware/admission.ts']
    );
  });
});

/** Each `getEmbedding(s)(...)` call in `source`, its parentheses balanced. */
const embeddingCalls = (source) => {
  return [...source.matchAll(/\bgetEmbeddings?\(/g)].map((match) => {
    let depth = 0;
    for (let i = match.index + match[0].length - 1; i < source.length; i++) {
      if (source[i] === '(') depth += 1;
      if (source[i] === ')') depth -= 1;
      if (depth === 0) return source.slice(match.index, i + 1);
    }
    return source.slice(match.index);
  });
};

/**
 * A write that embeds what it stores asks admission once, before anything is
 * written (`lib/embeddingAdmission.ts`); `getEmbeddings` takes a stored
 * subject only with that ask.
 */
describe('admission on embedding writes', () => {
  test('a stored subject is embedded only with its ask', () => {
    const unasked = sourceFiles.flatMap((entry) => {
      return embeddingCalls(code(path.join(srcDir, entry)))
        .filter((call) => {
          return /\bsubject: \{/.test(call) && !/\bask\b/.test(call);
        })
        .map(() => {
          return entry;
        });
    });
    assert.deepEqual(unasked, []);
    assert.match(
      code(path.join(srcDir, 'lib/embedding.ts')),
      /subject: NonNullable<EmbeddingSubject>; ask: EmbeddingWriteAsk/
    );
  });

  test('only embeddingAdmission.ts mints an ask', () => {
    assert.deepEqual(
      sourceFiles.filter((entry) => {
        return (
          entry !== 'lib/embeddingAdmission.ts' &&
          /\bas EmbeddingWriteAsk\b/.test(code(path.join(srcDir, entry)))
        );
      }),
      []
    );
  });

  test('every embedding write asks before it writes', () => {
    for (const [file, names] of [
      ['lib/embeddings.ts', ['embedForProject']],
      [
        'lib/documentIngestion.ts',
        ['enqueueDocumentIngestion', 'reingestDocument'],
      ],
      ['lib/documentContent.ts', ['prepareDocumentChunkChanges']],
    ]) {
      for (const name of names) {
        assert.match(exportedBody(file, name), /\baskEmbeddingWrite\(/, name);
      }
    }
    assert.match(
      exportedBody('lib/documents.ts', 'createDocument'),
      /\baskDocumentEmbedding\([\s\S]*\bcreateDocumentTextFile\(/
    );
    assert.match(
      exportedBody('lib/conversations.ts', 'updateConversation'),
      /\baskBacklogEmbedding\([\s\S]*\bconversation\.update\(/
    );
    assert.match(
      code(path.join(srcDir, 'lib/memoryContents.ts')),
      /const embedOrNull = [\s\S]*?\baskEmbeddingWrite\([\s\S]*?\btry \{/
    );
  });

  test('only the converter callback reuses an ingest ask', () => {
    assert.deepEqual(
      sourceFiles.filter((entry) => {
        return (
          entry !== 'lib/embeddingAdmission.ts' &&
          /\baskOfClaimedConversion\(/.test(code(path.join(srcDir, entry)))
        );
      }),
      ['lib/ingestionCallback.ts']
    );
  });
});

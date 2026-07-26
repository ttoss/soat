import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * QA coverage-checklist guardrail — pure repo-structure validation with no REST
 * entry point (same class as openapiExamplePrefixes / openapiSchemaFields).
 *
 * Every module that has an OpenAPI spec must have a live-behavior QA checklist
 * at `docs/qa/<module>.md`, or an explicit entry in PENDING_FIRST_PASS below.
 *
 * The pending list is the visible backlog: adding a module to it is a conscious,
 * reviewable act, and it is expected to shrink. What this stops is a new module
 * shipping with nobody noticing that its documented behavior was never verified
 * against a running server.
 *
 * See docs/qa/README.md for what a checklist contains and how to run a pass.
 */

const SPEC_DIR = path.resolve(__dirname, '../../../../src/rest/openapi/v1');
const QA_DIR = path.resolve(__dirname, '../../../../../../docs/qa');

/**
 * Modules awaiting their first live QA pass. Remove an entry when
 * `docs/qa/<module>.md` lands — never add one to silence this test for a module
 * that already has a checklist.
 */
const PENDING_FIRST_PASS = new Set([
  'actors',
  'agents',
  'ai-providers',
  'api-keys',
  'approvals',
  'chats',
  'conversations',
  'discussions',
  'documents',
  'embeddings',
  'exceptions',
  'files',
  'formations',
  'generations',
  'ingestion-rules',
  'memoryEntries',
  'policies',
  'projects',
  'secrets',
  'sessions',
  'tools',
  'traces',
  'triggers',
  'usage',
  'users',
  'webhooks',
]);

const specModules = (): string[] => {
  return fs
    .readdirSync(SPEC_DIR)
    .filter((file) => {
      return file.endsWith('.yaml');
    })
    .map((file) => {
      return path.basename(file, '.yaml');
    })
    .sort();
};

const checklistModules = (): string[] => {
  return fs
    .readdirSync(QA_DIR)
    .filter((file) => {
      return file.endsWith('.md') && file !== 'README.md';
    })
    .map((file) => {
      return path.basename(file, '.md');
    })
    .sort();
};

describe('QA coverage checklists', () => {
  test('every OpenAPI module has a checklist or an explicit pending entry', () => {
    const covered = new Set(checklistModules());

    const unaccounted = specModules().filter((module) => {
      return !covered.has(module) && !PENDING_FIRST_PASS.has(module);
    });

    expect(unaccounted).toEqual([]);
  });

  test('no module is both checklisted and listed as pending', () => {
    const stale = checklistModules().filter((module) => {
      return PENDING_FIRST_PASS.has(module);
    });

    expect(stale).toEqual([]);
  });

  test('the pending list has no entries for modules that do not exist', () => {
    const modules = new Set(specModules());

    const orphans = [...PENDING_FIRST_PASS].filter((module) => {
      return !modules.has(module);
    });

    expect(orphans).toEqual([]);
  });

  test('every checklist names a real module', () => {
    const modules = new Set(specModules());

    const orphans = checklistModules().filter((module) => {
      return !modules.has(module);
    });

    expect(orphans).toEqual([]);
  });

  describe.each(checklistModules())('docs/qa/%s.md', (module) => {
    const body = fs.readFileSync(path.join(QA_DIR, `${module}.md`), 'utf8');

    test('links back to the checklist conventions', () => {
      expect(body).toContain('README.md');
    });

    test('has a run history table', () => {
      expect(body).toMatch(/^## Run history$/m);
    });

    test('has at least one checklist item', () => {
      expect(body).toMatch(/^- \[[ x]\] /m);
    });

    test('every unchecked item is annotated with a reason or an issue link', () => {
      const unchecked = body.split('\n').filter((line) => {
        return line.trimStart().startsWith('- [ ] ');
      });

      // An unchecked box means "not verified" — either a known gap or a live
      // defect. Both are fine; a bare unchecked box with no explanation is not,
      // because it is indistinguishable from an item someone forgot to tick.
      const unexplained = unchecked.filter((line) => {
        return !/\*not |—|--|issues\/\d+/.test(line);
      });

      expect(unexplained).toEqual([]);
    });
  });
});

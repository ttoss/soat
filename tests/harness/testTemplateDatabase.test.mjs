import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  createTemplateDatabaseName,
  publishTestDatabaseConnection,
  readTemplateDatabase,
  readTestDatabaseConnection,
} from '../../packages/server/tests/unit/testDatabase.ts';

const CONNECTION = {
  host: 'localhost',
  port: 5432,
  username: 'postgres',
  password: '',
};

const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;

/**
 * Two suite runs may share one `TEST_DB_HOST`; a template name both of them
 * build would let one run's `globalSetup` drop the other's template.
 */
describe('test template database', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  test('each run names a template of its own', () => {
    const first = createTemplateDatabaseName();
    const second = createTemplateDatabaseName();

    assert.notEqual(first, second);
    for (const name of [first, second]) {
      assert.match(name, /^[a-z0-9_]+$/);
      assert.ok(name.length <= POSTGRES_IDENTIFIER_MAX_LENGTH);
    }
  });

  test('workers read the template globalSetup published', () => {
    const template = createTemplateDatabaseName();

    publishTestDatabaseConnection({ connection: CONNECTION, template });

    assert.equal(readTemplateDatabase(), template);
    assert.deepEqual(readTestDatabaseConnection(), CONNECTION);
  });

  test('an unpublished template is an error, not a shared default', () => {
    delete process.env.SOAT_TEST_DB_TEMPLATE;

    assert.throws(() => {
      return readTemplateDatabase();
    }, /SOAT_TEST_DB_TEMPLATE is unset/);
  });
});
